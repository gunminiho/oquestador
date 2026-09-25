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

previous_patched_functions = '''def _codex_model_config_options(model: str) -> tuple[tuple[str, str], ...]:
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


def _acp_provider_key(agent_name: str | None) -> str | None:
    provider = detect_acp_provider_by_agent_name(agent_name or "")
    if provider is not None:
        return provider.key
    normalized = (agent_name or "").strip().lower()
    if normalized in {"claude", "claude-code", "claude-agent"}:
        return "claude-code"
    if normalized in {"codex", "codex-acp"}:
        return "codex"
    return None


def _model_config_options(
    agent_name: str | None,
    model: str,
) -> tuple[tuple[str, str], ...]:
    provider_key = _acp_provider_key(agent_name)
    if provider_key == "codex":
        return _codex_model_config_options(model)
    if provider_key == "claude-code":
        return _claude_model_config_options(model)
    return ((_MODEL_CONFIG_OPTION_ID, model),)


def _model_config_model_value(agent_name: str | None, model: str) -> str:
    """Return the provider-facing model id from the model config option."""
    return _model_config_options(agent_name, model)[0][1]
'''

old_session_meta = '''                session_meta = build_session_model_meta(agent_name, self.acp_model)
'''

previous_session_meta = '''                session_model = self.acp_model
                if session_model:
                    session_model = _model_config_options(
                        agent_name, session_model
                    )[0][1]
                session_meta = build_session_model_meta(agent_name, session_model)
'''

new_session_meta = '''                session_model = self.acp_model
                if session_model:
                    session_model = _model_config_model_value(agent_name, session_model)
                session_meta = build_session_model_meta(agent_name, session_model)
'''

old_apply_legacy = '''    elif hasattr(conn, "set_session_model"):
        await conn.set_session_model(  # type: ignore[attr-defined]
            model_id=model, session_id=session_id
        )
'''

new_apply_legacy = '''    elif hasattr(conn, "set_session_model"):
        await conn.set_session_model(  # type: ignore[attr-defined]
            model_id=_model_config_model_value(agent_name, model), session_id=session_id
        )
'''

patched_claude_function = '''def _claude_model_config_options(model: str) -> tuple[tuple[str, str], ...]:
    """Map combined Canvas Claude model IDs to claude-agent-acp config options."""
    base_model, sep, effort = model.rpartition("/")
    if sep and base_model and effort in _CLAUDE_EFFORTS:
        return (
            (_MODEL_CONFIG_OPTION_ID, base_model),
            ("effort", effort),
        )
    return ((_MODEL_CONFIG_OPTION_ID, model),)
'''

patched_provider_dispatch = '''def _model_config_options(
    agent_name: str | None,
    model: str,
) -> tuple[tuple[str, str], ...]:
    provider_key = _acp_provider_key(agent_name)
    if provider_key == "codex":
        return _codex_model_config_options(model)
    if provider_key == "claude-code":
        return _claude_model_config_options(model)
    return ((_MODEL_CONFIG_OPTION_ID, model),)
'''

patched_model_value = '''def _model_config_model_value(agent_name: str | None, model: str) -> str:
    """Return the provider-facing model id from the model config option."""
    return _model_config_options(agent_name, model)[0][1]
'''

patched_provider_key = '''def _acp_provider_key(agent_name: str | None) -> str | None:
    provider = detect_acp_provider_by_agent_name(agent_name or "")
    if provider is not None:
        return provider.key
    normalized = (agent_name or "").strip().lower()
    if normalized in {"claude", "claude-code", "claude-agent"}:
        return "claude-code"
    if normalized in {"codex", "codex-acp"}:
        return "codex"
    return None
'''

def _count_or_fail(needle: str, label: str, text: str = source) -> int:
    count = text.count(needle)
    if count > 1:
        raise SystemExit(
            f"Patch guard failed: {label} block was found {count} times."
        )
    return count


new_counts = {
    "constants": _count_or_fail(new_constants, "patched constants"),
    "claude_function": _count_or_fail(
        patched_claude_function, "patched Claude model-config function"
    ),
    "provider_key": _count_or_fail(patched_provider_key, "patched provider key"),
    "provider_dispatch": _count_or_fail(
        patched_provider_dispatch, "patched provider dispatch"
    ),
    "model_value": _count_or_fail(patched_model_value, "patched model value helper"),
    "session_meta": _count_or_fail(new_session_meta, "patched session-meta"),
    "apply_legacy": _count_or_fail(new_apply_legacy, "patched legacy model apply"),
}
previous_counts = {
    "functions": _count_or_fail(
        previous_patched_functions, "previous patched model-config function"
    ),
    "session_meta": _count_or_fail(
        previous_session_meta, "previous patched session-meta"
    ),
}
old_counts = {
    # The baseline constants are a prefix of the patched constants, so subtract
    # the patched block count before deciding whether a standalone baseline
    # constants block remains.
    "constants": _count_or_fail(old_constants, "baseline constants")
    - new_counts["constants"],
    "functions": _count_or_fail(old_functions, "baseline model-config function"),
    "session_meta": _count_or_fail(old_session_meta, "baseline session-meta"),
    "apply_legacy": _count_or_fail(old_apply_legacy, "baseline legacy model apply"),
}

if old_counts["constants"] < 0:
    raise SystemExit(
        "Patch guard failed: patched constants count exceeded baseline "
        "constants count."
    )

baseline_source = all(count == 1 for count in old_counts.values()) and all(
    count == 0 for count in new_counts.values()
) and all(count == 0 for count in previous_counts.values())
previous_patched_source = (
    old_counts["constants"] == 0
    and old_counts["functions"] == 0
    and old_counts["session_meta"] == 0
    and old_counts["apply_legacy"] == 1
    and new_counts["constants"] == 1
    and new_counts["claude_function"] == 1
    and new_counts["provider_key"] == 0
    and new_counts["provider_dispatch"] == 0
    and new_counts["model_value"] == 0
    and new_counts["session_meta"] == 0
    and new_counts["apply_legacy"] == 0
    and previous_counts["functions"] == 1
    and previous_counts["session_meta"] == 1
)
already_patched_source = all(count == 0 for count in old_counts.values()) and all(
    count == 1 for count in new_counts.values()
) and all(
    count == 0 for count in previous_counts.values()
)

if baseline_source:
    patched = source.replace(old_constants, new_constants, 1)
    patched = patched.replace(old_functions, new_functions, 1)
    patched = patched.replace(old_session_meta, new_session_meta, 1)
    patched = patched.replace(old_apply_legacy, new_apply_legacy, 1)
elif previous_patched_source:
    patched = source.replace(previous_patched_functions, new_functions, 1)
    patched = patched.replace(previous_session_meta, new_session_meta, 1)
    patched = patched.replace(old_apply_legacy, new_apply_legacy, 1)
elif already_patched_source:
    patched = source
else:
    raise SystemExit(
        "Patch guard failed: expected either the exact openhands-sdk 1.49.4 "
        "baseline blocks or the exact already-patched blocks."
    )

required_after_patch = {
    "Claude effort constants": new_constants,
    "Claude model/effort config mapper": patched_claude_function,
    "Claude provider dispatch": patched_provider_dispatch,
    "provider-facing model helper": patched_model_value,
    "base-model session metadata": new_session_meta,
    "base-model legacy model apply": new_apply_legacy,
    "initial/runtime/resume config option application": (
        "for config_id, value in _model_config_options(agent_name, model):"
    ),
}

for label, needle in required_after_patch.items():
    count = patched.count(needle)
    if count != 1:
        raise SystemExit(
            f"Patch guard failed: {label} was found {count} times after patch."
        )

path.write_text(patched, encoding="utf-8")

print(f"Patched {path}")
print(f"openhands-sdk={actual_version}")
print("Claude model/effort support: enabled")
print("Claude session meta uses base model only: enabled")
