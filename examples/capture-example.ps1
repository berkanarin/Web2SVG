corepack enable
corepack prepare pnpm@9.15.4 --activate
corepack pnpm install
corepack pnpm capture -- --url https://example.com --out exports/current
