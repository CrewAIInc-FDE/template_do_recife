import os

from crewai import Agent, Crew, Process, Task
from crewai.agents.agent_builder.base_agent import BaseAgent
from crewai.project import CrewBase, agent, crew, task
from crewai_tools import MongoDBVectorSearchConfig, MongoDBVectorSearchTool

_DATABASE_NAME = "do-recife"
_COLLECTION_NAME = "do-recife-rag-enriched"
_VECTOR_INDEX_NAME = "vector_index"
_EMBEDDING_MODEL = "text-embedding-3-large"
_EMBEDDING_DIMENSIONS = 3072


@CrewBase
class DoRecifeChatCrew:
    """DoRecifeChatCrew crew"""

    agents: list[BaseAgent]
    tasks: list[Task]

    def _mongo_tool(self) -> MongoDBVectorSearchTool:
        return MongoDBVectorSearchTool(
            connection_string=os.environ["MONGODB_CONNECTION_STRING"],
            database_name=_DATABASE_NAME,
            collection_name=_COLLECTION_NAME,
            vector_index_name=_VECTOR_INDEX_NAME,
            text_key="text",
            embedding_key="embedding",
            embedding_model=_EMBEDDING_MODEL,
            dimensions=_EMBEDDING_DIMENSIONS,
            query_config=MongoDBVectorSearchConfig(limit=6),
        )

    @agent
    def do_researcher(self) -> Agent:
        return Agent(
            config=self.agents_config["do_researcher"],  # type: ignore[index]
            tools=[self._mongo_tool()],
            verbose=True,
        )

    @agent
    def do_reporter(self) -> Agent:
        return Agent(
            config=self.agents_config["do_reporter"],  # type: ignore[index]
            verbose=True,
        )

    @task
    def retrieval_task(self) -> Task:
        return Task(
            config=self.tasks_config["retrieval_task"],  # type: ignore[index]
        )

    @task
    def answer_task(self) -> Task:
        return Task(
            config=self.tasks_config["answer_task"],  # type: ignore[index]
            context=[self.retrieval_task()],
        )

    @crew
    def crew(self) -> Crew:
        """Creates the DoRecifeChatCrew crew"""
        return Crew(
            agents=self.agents,
            tasks=self.tasks,
            process=Process.sequential,
            verbose=True,
        )
