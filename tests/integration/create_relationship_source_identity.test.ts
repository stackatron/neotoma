/**
 * create_relationship (single, MCP/CLI path) must derive its synthetic source row
 * deterministically from the relationship itself, not from the wall clock.
 *
 * Regression: the server wrapper inserted a `sources` row with
 * `content_hash: \`relationship_${Date.now()}\``. Two relationships created within
 * the same millisecond collided on UNIQUE(content_hash, user_id) and the second
 * failed with "UNIQUE constraint failed: sources.content_hash". The batch path
 * (create_relationships) already delegated source creation to
 * relationshipsService, which hashes (relationship_key, user_id, metadata) and
 * reuses an existing row; the single path must behave the same way.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "crypto";
import { db } from "../../src/db.js";
import { NeotomaServer } from "../../src/server.js";
import { seedTestSchema, cleanupTestEntityType } from "../helpers/test_schema_helpers.js";

const USER_ID = "00000000-0000-0000-0000-000000000000";
const ENTITY_TYPE = "test_rel_source_identity";

function parse(result: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(result.content[0].text);
}

describe("create_relationship source row identity", () => {
  let server: NeotomaServer;
  let a: string;
  let b: string;
  let c: string;

  beforeAll(async () => {
    const run = randomUUID().slice(0, 8);
    server = new NeotomaServer();
    (server as any).authenticatedUserId = USER_ID;
    await seedTestSchema(server, ENTITY_TYPE, { name: { type: "string" } });
    const stored = parse(
      await server.executeToolForCli(
        "store",
        {
          entities: [
            { entity_type: ENTITY_TYPE, name: `rel-src-a-${run}` },
            { entity_type: ENTITY_TYPE, name: `rel-src-b-${run}` },
            { entity_type: ENTITY_TYPE, name: `rel-src-c-${run}` },
          ],
          idempotency_key: `rel-source-identity-seed-${randomUUID()}`,
        },
        USER_ID
      )
    );
    [a, b, c] = stored.entities.map((e: { entity_id: string }) => e.entity_id);
  });

  afterAll(async () => {
    await cleanupTestEntityType(ENTITY_TYPE, USER_ID);
  });

  it("creates two relationships within the same millisecond without a source collision", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      const first = parse(
        await server.executeToolForCli(
          "create_relationship",
          { relationship_type: "REFERS_TO", source_entity_id: a, target_entity_id: b, metadata: { added_by: "test" } },
          USER_ID
        )
      );
      const second = parse(
        await server.executeToolForCli(
          "create_relationship",
          { relationship_type: "REFERS_TO", source_entity_id: a, target_entity_id: c, metadata: { added_by: "test" } },
          USER_ID
        )
      );
      expect(first.relationship_key).toBe(`REFERS_TO:${a}:${b}`);
      expect(second.relationship_key).toBe(`REFERS_TO:${a}:${c}`);
    } finally {
      nowSpy.mockRestore();
    }

    const { data: obs } = await db
      .from("relationship_observations")
      .select("relationship_key, source_id")
      .in("relationship_key", [`REFERS_TO:${a}:${b}`, `REFERS_TO:${a}:${c}`])
      .eq("user_id", USER_ID);
    expect(obs?.length).toBe(2);
    const sourceIds = new Set((obs ?? []).map((o: { source_id: string }) => o.source_id));
    expect(sourceIds.size).toBe(2);

    const { data: sources } = await db
      .from("sources")
      .select("content_hash")
      .in("id", [...sourceIds]);
    for (const s of sources ?? []) {
      expect(String(s.content_hash)).not.toMatch(/^relationship_\d{13}$/);
    }
  });

  it("re-creating the same relationship reuses its source row", async () => {
    const args = { relationship_type: "DEPENDS_ON", source_entity_id: b, target_entity_id: c, metadata: { k: 1 } };
    const first = parse(await server.executeToolForCli("create_relationship", args, USER_ID));
    const second = parse(await server.executeToolForCli("create_relationship", args, USER_ID));
    expect(second.relationship_key).toBe(first.relationship_key);

    const { data: obs } = await db
      .from("relationship_observations")
      .select("source_id")
      .eq("relationship_key", first.relationship_key)
      .eq("user_id", USER_ID);
    const sourceIds = new Set((obs ?? []).map((o: { source_id: string }) => o.source_id));
    expect(sourceIds.size).toBe(1);
  });
});
