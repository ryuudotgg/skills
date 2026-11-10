import { blobBytes, openStore, storePath } from "../../plans/store.ts";

const [sha256, flag, ...rest] = process.argv.slice(2);
if (sha256 === undefined || rest.length > 0 || (flag !== undefined && flag !== "--drop")) {
  process.stderr.write("usage: bun packages/cli/src/sessions/fixture/blob.ts <sha256> [--drop]\n");
  process.exit(2);
}

const store = openStore(storePath());
try {
  if (flag === "--drop") {
    const { changes } = store.db.run("DELETE FROM blobs WHERE sha256 = ?", [sha256]);
    if (changes === 0) throw new Error(`no blob ${sha256} in ${storePath()}`);
  } else {
    const bytes = blobBytes(store.db, sha256);
    if (bytes === undefined) throw new Error(`no blob ${sha256} in ${storePath()}`);
    process.stdout.write(bytes);
  }
} catch (error) {
  process.stderr.write(`blob.ts: ${(error as Error).message}\n`);
  process.exitCode = 1;
} finally {
  store.db.close();
}
