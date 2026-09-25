import os
from importlib.metadata import version
from pathlib import Path

EXPECTED_VERSION = "1.49.4"
actual_version = version("openhands-sdk")

if actual_version != EXPECTED_VERSION:
    raise SystemExit(
        f"Unsupported openhands-sdk version: {actual_version}. "
        f"Expected exactly {EXPECTED_VERSION}."
    )

path = Path(
    os.environ.get(
        "PATCH_TARGET",
        "/usr/local/lib/python3.13/site-packages/"
        "openhands/sdk/agent/acp_agent.py",
    )
)

source = path.read_text(encoding="utf-8")

old_constants = '''_MODEL_CONFIG_OPTION_ID = "model"
_CODEX_REASONING_EFFORTS: Final[frozenset[str]] = frozenset(
    {"low", "medium", "high", "xhigh"}
)
'''

new_constants = '''_MODEL_CONFIG_OPTION_ID = "model"
_CODEX_REASONING_EFFORTS: Final[frozenset[str]] = frozenset(
    {"low", "medium", "high", "xhigh"}
)
_CLAUDE_EFFORTS: Final[frozenset[str]] = frozenset(
    {"low", "medium", "high", "xhigh", "max"}
)
'''

old_functions = '''def _codex_model_config_options(model: str) -> tuple[tuple[str, str], ...]:
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
'''

new_functions = '''def _codex_model_config_options(model: str) -> tuple[tuple[str, str], ...]:
    """Map combined Canvas Codex model IDs to codex-acp config options."""
    base_model, sep, effort = model.rpartition("/")
    if sep and base_model and effort in _CODEX_REASONING_EFFORTS:
        return (
            (_MODEL_CONFIG_OPTION_ID, base_model),
            ("reasoning_effort", effort),
        )
    return ((_MODEL_CONFIG_OPTION_ID, model),)


def _claude_model_config_options(model: str) -> tuple[tuple[str, str], ...]:
    """Map combined Canvas Claude model IDs to claude-agent-acp config options."""
    base_model, sep, effort = model.rpartition("/")
    if sep and base_model and effort in _CLAUDE_EFFORTS:
        return (
            (_MODEL_CONFIG_OPTION_ID, base_model),
            ("effort", effort),
        )
    return ((_MODEL_CONFIG_OPTION_ID, model),)


def _model_config_options(
    agent_name: str | None,
    model: str,
) -> tuple[tuple[str, str], ...]:
    provider = detect_acp_provider_by_agent_name(agent_name or "")
    if provider is not None and provider.key == "codex":
        return _codex_model_config_options(model)
    if provider is not None and provider.key == "claude-code":
        return _claude_model_config_options(model)
    return ((_MODEL_CONFIG_OPTION_ID, model),)
'''

old_session_meta = '''                session_meta = build_session_model_meta(agent_name, self.acp_model)
'''

new_session_meta = '''                session_model = self.acp_model
                if session_model:
                    session_model = _model_config_options(
                        agent_name, session_model
                    )[0][1]
                session_meta = build_session_model_meta(agent_name, session_model)
'''

if source.count(old_constants) != 1:
    raise SystemExit(
        "Patch guard failed: expected constants block was not found exactly once."
    )

if source.count(old_functions) != 1:
    raise SystemExit(
        "Patch guard failed: expected model-config function block "
        "was not found exactly once."
    )

if source.count(old_session_meta) != 1:
    raise SystemExit(
        "Patch guard failed: expected session-meta block "
        "was not found exactly once."
    )

patched = source.replace(old_constants, new_constants, 1)
patched = patched.replace(old_functions, new_functions, 1)
patched = patched.replace(old_session_meta, new_session_meta, 1)

path.write_text(patched, encoding="utf-8")

print(f"Patched {path}")
print(f"openhands-sdk={actual_version}")
print("Claude model/effort support: enabled")
print("Claude session meta uses base model only: enabled")
