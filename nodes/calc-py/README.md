# calc-py

Demo brAIn web-transport node, written in Python.

It proves the `transport: "web"` pattern: a node lives behind any HTTP
server (here FastAPI), the framework opens a WebSocket to
`http://127.0.0.1:9001/brain/ws`, and bus messages on `calc.request`
are forwarded as JSON frames. The handler computes the result via a
restricted AST evaluator and publishes `calc.result` back through the
same socket.

## Run

```bash
cd nodes/calc-py
python3.11 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/pip install ../../packages/python-sdk
CALC_PY_TOKEN=letmein .venv/bin/uvicorn server:app --port 9001
```

## Spawn from brAIn

```bash
# In brAIn, set the matching env so the WebRunner can authenticate:
export CALC_PY_TOKEN=letmein

# Then either spawn manually or via curl:
curl -X POST http://localhost:3000/nodes \
  -H 'content-type: application/json' \
  -d '{"type":"calc-py","name":"calc"}'
```

## Try it

```bash
# Find the spawned node id
NODE_ID=$(curl -s http://localhost:3000/nodes | jq -r '.[] | select(.type=="calc-py") | .id')

# Send an expression
curl -X POST "http://localhost:3000/nodes/$NODE_ID/ui/send" \
  -H 'content-type: application/json' \
  -d '{"topic":"calc.request","content":"(2 + 3) * 7"}'

# Listen on calc.result
curl "http://localhost:3000/network/messages?topic=calc.result&last=5"
```

## Anatomy

```
config.json   transport: ["web"], web.url + bearer auth
server.py     ~50 lines: FastAPI app, BrainNode, one @on("calc.request") handler
requirements.txt   fastapi + uvicorn (the Python SDK is local: ../../packages/python-sdk)
```

No `dist/`, no TypeScript, no `handler.js`. The brAIn `WebRunner`
forwards messages over WS — the framework treats this node like any
other on the bus.
