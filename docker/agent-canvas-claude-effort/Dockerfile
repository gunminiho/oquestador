FROM ghcr.io/openhands/agent-canvas@sha256:0fb45776639f4f90dd8f937532b17845007cafa907f2db598578669c46a6ec87

USER root

COPY patch_claude_effort.py /tmp/patch_claude_effort.py

RUN python /tmp/patch_claude_effort.py \
    && rm /tmp/patch_claude_effort.py

USER openhands
