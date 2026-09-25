import asyncio
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from importlib.metadata import version
from pathlib import Path


REPO_DIR = Path(__file__).resolve().parents[2]
PATCH_SCRIPT = Path(__file__).with_name("patch_claude_effort.py")


UPSTREAM_FIXTURE = r'''
from typing import Any, Final


class Provider:
    def __init__(self, key: str) -> None:
        self.key = key
        self.supports_set_session_model = True
        self.supports_runtime_model_switch = True


def detect_acp_provider_by_agent_name(agent_name: str):
    if "claude" in agent_name:
        return Provider("claude-code")
    if "codex" in agent_name:
        return Provider("codex")
    return None


def build_session_model_meta(agent_name: str, model: str | None) -> dict[str, str]:
    return {} if model is None else {"model": model}


_MODEL_CONFIG_OPTION_ID = "model"
_CODEX_REASONING_EFFORTS: Final[frozenset[str]] = frozenset(
    {"low", "medium", "high", "xhigh"}
)


def _codex_model_config_options(model: str) -> tuple[tuple[str, str], ...]:
    """Map combined Canvas Codex model IDs to codex-acp config options."""
    base_model, sep, effort = model.rpartition("/")
    if sep and base_model and effort in _CODEX_REASONING_EFFORTS:
        return (
            (_MODEL_CONFIG_OPTION_ID, base_model),
            ("reasoning_effort", effort),
        )
    return ((_MODEL_CONFIG_OPTION_ID, model),)


def _model_config_options(
    agent_name: str | None,
    model: str,
) -> tuple[tuple[str, str], ...]:
    provider = detect_acp_provider_by_agent_name(agent_name or "")
    if provider is not None and provider.key == "codex":
        return _codex_model_config_options(model)
    return ((_MODEL_CONFIG_OPTION_ID, model),)


async def _apply_acp_model(
    conn: Any,
    session_id: str,
    model: str,
    *,
    agent_name: str | None = None,
    via_config_option: bool,
) -> None:
    if via_config_option:
        for config_id, value in _model_config_options(agent_name, model):
            await conn.set_config_option(
                config_id=config_id, value=value, session_id=session_id
            )
    elif hasattr(conn, "set_session_model"):
        await conn.set_session_model(  # type: ignore[attr-defined]
            model_id=model, session_id=session_id
        )


async def _maybe_set_session_model(
    conn: Any,
    agent_name: str,
    session_id: str,
    acp_model: str | None,
    *,
    via_config_option: bool,
) -> bool:
    if not acp_model:
        return False
    await _apply_acp_model(
        conn,
        session_id,
        acp_model,
        agent_name=agent_name,
        via_config_option=via_config_option,
    )
    return True


async def _reapply_session_model_on_resume(
    conn: Any,
    agent_name: str,
    session_id: str,
    acp_model: str | None,
    *,
    via_config_option: bool,
) -> bool:
    if not acp_model:
        return False
    await _apply_acp_model(
        conn,
        session_id,
        acp_model,
        agent_name=agent_name,
        via_config_option=via_config_option,
    )
    return True


async def create_session(conn: Any, agent_name: str, acp_model: str | None) -> None:
    self = type("Agent", (), {"acp_model": acp_model})()
    if True:
                session_meta = build_session_model_meta(agent_name, self.acp_model)
    await conn.new_session(cwd="/workspace", mcp_servers=[], **session_meta)
    await _maybe_set_session_model(
        conn,
        agent_name,
        "session-1",
        acp_model,
        via_config_option=True,
    )
'''


class FakeACPConnection:
    def __init__(self) -> None:
        self.config_options: list[tuple[str, str, str]] = []
        self.session_models: list[tuple[str, str]] = []
        self.new_session_kwargs: dict[str, object] | None = None

    async def set_config_option(
        self, *, config_id: str, value: str, session_id: str
    ) -> None:
        if config_id == "model" and "/" in value:
            raise AssertionError(f"combined model leaked to provider: {value}")
        self.config_options.append((config_id, value, session_id))

    async def set_session_model(self, *, model_id: str, session_id: str) -> None:
        if "/" in model_id:
            raise AssertionError(f"combined model leaked to provider: {model_id}")
        self.session_models.append((model_id, session_id))

    async def new_session(self, **kwargs: object) -> object:
        self.new_session_kwargs = kwargs
        return object()


def load_module(path: Path):
    spec = importlib.util.spec_from_file_location("patched_acp_agent", path)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class ClaudeEffortPatchTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.target = Path(self.tmp.name) / "acp_agent.py"
        self.target.write_text(textwrap.dedent(UPSTREAM_FIXTURE), encoding="utf-8")
        env = {
            **os.environ,
            "OPENHANDS_SUPPRESS_BANNER": "1",
            "PATCH_TARGET": str(self.target),
        }
        subprocess.run(
            [sys.executable, str(PATCH_SCRIPT)],
            cwd=REPO_DIR,
            env=env,
            check=True,
            capture_output=True,
            text=True,
        )
        self.module = load_module(self.target)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_claude_model_effort_options(self) -> None:
        options = self.module._model_config_options("claude-code", "opus[1m]/high")
        self.assertEqual(options, (("model", "opus[1m]"), ("effort", "high")))
        self.assertNotIn(("model", "opus[1m]/high"), options)

        self.assertEqual(
            self.module._model_config_options("claude-code", "opus[1m]"),
            (("model", "opus[1m]"),),
        )
        self.assertEqual(
            self.module._model_config_options("claude-code", "sonnet/medium"),
            (("model", "sonnet"), ("effort", "medium")),
        )
        self.assertEqual(
            self.module._model_config_options("claude-code", "opus[1m]/max"),
            (("model", "opus[1m]"), ("effort", "max")),
        )
        self.assertEqual(
            self.module._model_config_options("claude-code", "sonnet/xhigh"),
            (("model", "sonnet"), ("effort", "xhigh")),
        )

    def test_invalid_claude_suffix_is_not_silently_interpreted_as_effort(self) -> None:
        self.assertEqual(
            self.module._model_config_options("claude-code", "opus[1m]/foobar"),
            (("model", "opus[1m]/foobar"),),
        )

    def test_claude_session_creation_metadata_and_initial_config_use_base_model(self):
        conn = FakeACPConnection()

        asyncio.run(
            self.module.create_session(conn, "claude-code", "opus[1m]/high")
        )

        self.assertIsNotNone(conn.new_session_kwargs)
        self.assertEqual(conn.new_session_kwargs["model"], "opus[1m]")
        self.assertEqual(
            conn.config_options,
            [("model", "opus[1m]", "session-1"), ("effort", "high", "session-1")],
        )

    def test_claude_runtime_switch_and_resume_reapply_use_base_model(self) -> None:
        runtime_conn = FakeACPConnection()
        asyncio.run(
            self.module._apply_acp_model(
                runtime_conn,
                "runtime-session",
                "opus[1m]/high",
                agent_name="claude-code",
                via_config_option=True,
            )
        )
        self.assertEqual(
            runtime_conn.config_options,
            [
                ("model", "opus[1m]", "runtime-session"),
                ("effort", "high", "runtime-session"),
            ],
        )

        resume_conn = FakeACPConnection()
        asyncio.run(
            self.module._reapply_session_model_on_resume(
                resume_conn,
                "claude-code",
                "resume-session",
                "sonnet/medium",
                via_config_option=True,
            )
        )
        self.assertEqual(
            resume_conn.config_options,
            [
                ("model", "sonnet", "resume-session"),
                ("effort", "medium", "resume-session"),
            ],
        )

    def test_claude_legacy_session_model_path_uses_base_model(self) -> None:
        initial_conn = FakeACPConnection()
        asyncio.run(
            self.module._maybe_set_session_model(
                initial_conn,
                "claude-code",
                "initial-session",
                "opus[1m]/high",
                via_config_option=False,
            )
        )
        self.assertEqual(initial_conn.session_models, [("opus[1m]", "initial-session")])

        runtime_conn = FakeACPConnection()
        asyncio.run(
            self.module._apply_acp_model(
                runtime_conn,
                "runtime-session",
                "opus[1m]/max",
                agent_name="claude-code",
                via_config_option=False,
            )
        )
        self.assertEqual(runtime_conn.session_models, [("opus[1m]", "runtime-session")])

        resume_conn = FakeACPConnection()
        asyncio.run(
            self.module._reapply_session_model_on_resume(
                resume_conn,
                "claude-code",
                "resume-session",
                "sonnet/medium",
                via_config_option=False,
            )
        )
        self.assertEqual(resume_conn.session_models, [("sonnet", "resume-session")])

    def test_codex_regression_model_reasoning_effort(self) -> None:
        self.assertEqual(
            self.module._model_config_options("codex", "gpt-5.6-sol/high"),
            (("model", "gpt-5.6-sol"), ("reasoning_effort", "high")),
        )
        conn = FakeACPConnection()
        asyncio.run(
            self.module._apply_acp_model(
                conn,
                "codex-session",
                "gpt-5.6-sol/high",
                agent_name="codex",
                via_config_option=True,
            )
        )
        self.assertEqual(
            conn.config_options,
            [
                ("model", "gpt-5.6-sol", "codex-session"),
                ("reasoning_effort", "high", "codex-session"),
            ],
        )


class InstalledOpenHandsSDKPatchTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.target = Path(self.tmp.name) / "acp_agent.py"

        env = {**os.environ, "OPENHANDS_SUPPRESS_BANNER": "1"}
        proc = subprocess.run(
            [
                sys.executable,
                "-c",
                (
                    "from pathlib import Path; "
                    "import openhands.sdk.agent.acp_agent as acp; "
                    "print(Path(acp.__file__).resolve())"
                ),
            ],
            cwd=REPO_DIR,
            env=env,
            check=True,
            capture_output=True,
            text=True,
        )
        installed_acp_agent = Path(proc.stdout.strip().splitlines()[-1])
        shutil.copyfile(installed_acp_agent, self.target)

        patch_env = {
            **env,
            "PATCH_TARGET": str(self.target),
        }
        subprocess.run(
            [sys.executable, str(PATCH_SCRIPT)],
            cwd=REPO_DIR,
            env=patch_env,
            check=True,
            capture_output=True,
            text=True,
        )
        self.module = load_module(self.target)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_patch_targets_exact_sdk_version(self) -> None:
        self.assertEqual(version("openhands-sdk"), "1.49.4")

    def test_real_sdk_copy_splits_claude_initial_runtime_and_resume_paths(self):
        self.assertEqual(
            self.module._model_config_options("claude-agent", "opus[1m]/high"),
            (("model", "opus[1m]"), ("effort", "high")),
        )

        session_model = self.module._model_config_options(
            "claude-agent", "opus[1m]/high"
        )[0][1]
        self.assertEqual(
            self.module.build_session_model_meta("claude-agent", session_model),
            {"claudeCode": {"options": {"model": "opus[1m]"}}},
        )

        runtime_conn = FakeACPConnection()
        asyncio.run(
            self.module._apply_acp_model(
                runtime_conn,
                "runtime-session",
                "opus[1m]/high",
                agent_name="claude-agent",
                via_config_option=True,
            )
        )
        self.assertEqual(
            runtime_conn.config_options,
            [
                ("model", "opus[1m]", "runtime-session"),
                ("effort", "high", "runtime-session"),
            ],
        )

        resume_conn = FakeACPConnection()
        asyncio.run(
            self.module._reapply_session_model_on_resume(
                resume_conn,
                "claude-agent",
                "resume-session",
                "opus[1m]/max",
                via_config_option=True,
            )
        )
        self.assertEqual(
            resume_conn.config_options,
            [
                ("model", "opus[1m]", "resume-session"),
                ("effort", "max", "resume-session"),
            ],
        )

        legacy_conn = FakeACPConnection()
        asyncio.run(
            self.module._apply_acp_model(
                legacy_conn,
                "legacy-session",
                "opus[1m]/high",
                agent_name="claude-agent",
                via_config_option=False,
            )
        )
        self.assertEqual(legacy_conn.session_models, [("opus[1m]", "legacy-session")])

    def test_real_sdk_copy_preserves_codex_reasoning_effort(self) -> None:
        conn = FakeACPConnection()
        asyncio.run(
            self.module._apply_acp_model(
                conn,
                "codex-session",
                "gpt-5.6-sol/high",
                agent_name="codex",
                via_config_option=True,
            )
        )
        self.assertEqual(
            conn.config_options,
            [
                ("model", "gpt-5.6-sol", "codex-session"),
                ("reasoning_effort", "high", "codex-session"),
            ],
        )


if __name__ == "__main__":
    unittest.main()
