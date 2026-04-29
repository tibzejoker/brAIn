"""brain-web — minimal Python SDK for `transport: web` brAIn nodes.

Drop a `BrainNode` instance into any FastAPI app, register message
handlers, and the framework will discover the node, forward bus
messages over a WebSocket, and accept publish/subscribe replies.
"""
from .node import BrainNode, Message, MessageHandler, on_message

__all__ = ["BrainNode", "Message", "MessageHandler", "on_message"]
