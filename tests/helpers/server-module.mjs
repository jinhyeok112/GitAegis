import { existsSync, readFileSync } from "node:fs";
import { createRequire, Module } from "node:module";
import { resolve } from "node:path";
import ts from "typescript";

// Compile isolated server modules for Node tests without loading Next's RSC
// marker. Aliases still resolve to the actual production modules under test.
export function loadServerModule(path, stubs = {}) {
  const cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const mod = new Module(filename);
    const baseRequire = createRequire(filename);
    mod.require = name => {
      if (name === "server-only") return {};
      if (Object.hasOwn(stubs, name)) return stubs[name];
      if (name.startsWith("@/")) {
        const path = resolve(name.slice(2));
        return load(existsSync(path + ".ts") ? path + ".ts" : path + ".tsx");
      }
      return baseRequire(name);
    };
    cache.set(filename, mod);
    mod._compile(ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
    return mod.exports;
  }
  return load(resolve(path));
}
