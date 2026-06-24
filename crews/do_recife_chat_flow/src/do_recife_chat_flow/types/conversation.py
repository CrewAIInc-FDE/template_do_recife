from pydantic import BaseModel

from .message import Message


class Conversation(BaseModel):
    user_message: Message | None = None
    messages: list[Message] = []
