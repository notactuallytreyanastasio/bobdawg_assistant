# What a web chat's workspace runs in. The server starts one of these for each tool call, with
# no network and little else: see ds4_workspace.h for how it is held. Build it with
#   docker build -t ds4-sandbox sandbox
FROM alpine:3.22
RUN apk add --no-cache python3 py3-pip git build-base bash nodejs npm ripgrep curl jq sqlite tree less \
 && adduser -D -u 1000 -h /work sandbox \
 && mkdir -p /opt/ds4 /snapshots \
 && chown 1000:1000 /work /snapshots
COPY tool.py /opt/ds4/tool.py
USER 1000:1000
WORKDIR /work
ENV HOME=/work PATH=/usr/local/bin:/usr/bin:/bin
ENTRYPOINT ["python3", "/opt/ds4/tool.py"]
