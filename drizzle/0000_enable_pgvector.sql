-- Enable pgvector. Unused for now, so V2 retrieval needs no migration later.
-- Neon ships the extension; locally the pgvector/pgvector:pg17 image does.
CREATE EXTENSION IF NOT EXISTS vector;
