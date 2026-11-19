import type { Client } from "@libsql/client";

export type RepositoryClient = Pick<Client, "execute" | "batch">;
