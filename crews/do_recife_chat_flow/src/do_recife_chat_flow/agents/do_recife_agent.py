from pathlib import Path

from crewai import LLM, Agent

from do_recife_chat_flow.tools import DoRecifeVectorSearchTool
from do_recife_chat_flow.types import Message

_SKILLS_DIR = Path(__file__).resolve().parent.parent / "skills"


class DoRecifeAgent:
    """Conversational RAG agent over the Diário Oficial do Recife."""

    def __init__(self) -> None:
        self._agent = Agent(
            role="Diário Oficial do Recife Conversational Assistant",
            goal=(
                "Answer the user's questions about the Diário Oficial do Recife "
                "accurately, grounding every answer in passages retrieved from "
                "the official gazette vector store, while keeping an engaging, "
                "transparent conversation focused on the Diário Oficial."
            ),
            backstory=(
                "You are a helpful, conversational assistant specialized in the "
                "Diário Oficial do Recife (the official gazette of the city of "
                "Recife). You are engaging and transparent: you make your "
                "research visible, ground every claim in the official gazette, "
                "and keep the dialogue flowing while staying on topic. You keep "
                "prior turns of the conversation in mind and follow the Diário "
                "Oficial do Recife conversation & search playbook for how to "
                "search, cite, and reply."
            ),
            tools=[DoRecifeVectorSearchTool()],
            skills=[str(_SKILLS_DIR)],
            llm=LLM(model="anthropic/claude-haiku-4-5", stream=True),
            verbose=False,
        )

    @staticmethod
    def _build_prompt(messages: list[Message]) -> str:
        history = "\n".join(f"{m.role}: {m.content}" for m in messages[:-1])
        question = messages[-1].content
        return (
            "Here is the conversation so far:\n"
            f"{history}\n\n"
            "Now answer the latest user message, taking the conversation "
            f"into account:\n{question}\n\n"
        )

    def answer(self, messages: list[Message]) -> str:
        """Answer the latest message given the full conversation history."""
        result = self._agent.kickoff(self._build_prompt(messages))
        return result.raw
