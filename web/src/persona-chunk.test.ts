import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The service worker's precache ignores the Persona chunk by FILE NAME (`**/persona-*.js` in
// vite.config.ts), and that name only exists because the lazy module is `persona.tsx`. Renaming the
// module, or adding a `chunkFileNames`/`manualChunks` rule, would make the glob match nothing and put
// a ~200 kB Rive chunk back into every install's precache with no test noticing. This pins both ends.

const root = join(__dirname, "..");
const config = readFileSync(join(root, "vite.config.ts"), "utf8");

describe("the lazy Persona chunk stays out of the precache", () => {
  it("the ignore glob is still in the Workbox config", () => {
    expect(config).toContain('"**/persona-*.js"');
  });

  it("the lazy module still has the basename the glob keys on", () => {
    expect(existsSync(join(root, "src", "components", "ai-elements", "persona.tsx"))).toBe(true);
  });

  it("nothing renames chunks, which would silently void the glob", () => {
    expect(config).not.toMatch(/chunkFileNames|manualChunks/);
  });

  it("the sheet loads Persona through a dynamic import, which is what makes it a chunk at all", () => {
    const sheet = readFileSync(join(root, "src", "components", "voice-sheet.tsx"), "utf8");
    expect(sheet).toContain('import("@/components/ai-elements/persona")');
  });
});
