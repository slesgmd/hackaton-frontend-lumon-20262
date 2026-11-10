import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

function buildSha(mode: string): string {
  if (mode !== "production") return "dev";
  let sha = process.env.CF_PAGES_COMMIT_SHA?.slice(0, 7) ?? "";
  if (!sha) {
    sha = execSync("git rev-parse --short=7 HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  }
  if (!/^[0-9a-f]{7}$/.test(sha)) throw new Error(`X-Lumon-Build inválido: "${sha}"`);
  return sha;
}

/** Genera dist/_headers con la CSP a partir de las variables VITE_*, sin duplicar URLs. */
function securityHeaders(env: Record<string, string>): Plugin {
  return {
    name: "lumon-security-headers",
    apply: "build",
    closeBundle() {
      const connect = new Set<string>(["'self'"]);
      for (const key of ["VITE_API_BASE_URL", "VITE_WS_BASE_URL", "VITE_SUPABASE_URL"]) {
        const value = env[key];
        if (value) connect.add(new URL(value).origin);
      }
      const images = new Set<string>(["'self'", "data:", "blob:"]);
      if ((env.VITE_STORAGE_PROVIDER ?? "").toUpperCase() === "CLOUDINARY") {
        connect.add("https://api.cloudinary.com"); // subida unsigned
        images.add("https://res.cloudinary.com"); // entrega
      }
      if (env.VITE_SUPABASE_URL) images.add(new URL(env.VITE_SUPABASE_URL).origin);
      const csp = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        `img-src ${[...images].join(" ")}`,
        "font-src 'self'",
        `connect-src ${[...connect].join(" ")}`,
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; ");
      const headers = [
        "/",
        "  Cache-Control: no-cache",
        "",
        "/index.html",
        "  Cache-Control: no-cache",
        "",
        "/assets/*",
        "  Cache-Control: public, max-age=31536000, immutable",
        "",
        "/*",
        `  Content-Security-Policy: ${csp}`,
        "  X-Content-Type-Options: nosniff",
        "  Referrer-Policy: strict-origin-when-cross-origin",
        "",
        "/.well-known/lumon-verification.txt",
        "  Content-Type: text/plain; charset=utf-8",
        "",
      ].join("\n");
      writeFileSync(resolve("dist", "_headers"), headers);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react(), securityHeaders(env)],
    define: {
      __LUMON_BUILD__: JSON.stringify(buildSha(mode)),
    },
    build: {
      target: "es2022",
      sourcemap: false,
    },
  };
});
