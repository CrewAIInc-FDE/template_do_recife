import os

from crewai_tools import MongoDBVectorSearchConfig, MongoDBVectorSearchTool

_DATABASE_NAME = "do-recife"
_COLLECTION_NAME = "do-recife-rag-enriched"
_VECTOR_INDEX_NAME = "vector_index"
_EMBEDDING_MODEL = "text-embedding-3-large"
_EMBEDDING_DIMENSIONS = 3072
_RESULTS_LIMIT = 10


class DoRecifeVectorSearchTool(MongoDBVectorSearchTool):
    """Vector search over the Diário Oficial do Recife embeddings store.

    Pre-configured `MongoDBVectorSearchTool` pointing at the MongoDB Atlas
    cluster populated by the do_recife embedder, so the agent only needs to
    instantiate it with no arguments.
    """

    def __init__(self) -> None:
        super().__init__(
            connection_string=os.environ["MONGODB_CONNECTION_STRING"],
            database_name=_DATABASE_NAME,
            collection_name=_COLLECTION_NAME,
            vector_index_name=_VECTOR_INDEX_NAME,
            embedding_model=_EMBEDDING_MODEL,
            dimensions=_EMBEDDING_DIMENSIONS,
            query_config=MongoDBVectorSearchConfig(limit=_RESULTS_LIMIT),
        )
