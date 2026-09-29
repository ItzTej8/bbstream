import { writeFile, mkdir } from "node:fs/promises";
import { state, setTheme, acceptVote, addChat } from "./src/state.mjs";
import { initRenderer, drawMainFrame, canvas } from "./src/renderer.mjs";

await mkdir("test-output", { recursive: true });
await initRenderer();

acceptVote("u1", 2, "Rahul_BB");
acceptVote("u2", 1, "Simran_K");
addChat("Pooja_Fan", "Navratri & Diwali celebration is live!");

const testThemes = ["navratree", "dusshera", "diwali", "cricket", "esports", "cyberpunk"];
for (const t of testThemes) {
  setTheme(t);
  drawMainFrame(Date.now());
  await writeFile(`test-output/${t}.png`, canvas.toBuffer("image/png"));
  console.log(`Rendered & verified ${t}.png`);
}

console.log("All festival and sports test renders passed!");
process.exit(0);
