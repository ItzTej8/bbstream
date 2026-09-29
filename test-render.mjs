import { writeFile, mkdir } from "node:fs/promises";
import { state, setTheme, acceptVote, addChat } from "./src/state.mjs";
import { initRenderer, drawMainFrame, canvas } from "./src/renderer.mjs";
import { interactiveState, voteEvent, triggerSpotlight, setScreen } from "./src/interactive.mjs";

await mkdir("test-output", { recursive: true });
await initRenderer();

acceptVote("u1", 2, "Rahul_BB");
acceptVote("u2", 1, "Simran_K");
acceptVote("u3", 3, "Amit_Sharma");
acceptVote("u4", 17, "Gamer_Boy");
addChat("Pooja_Fan", "Mary Kom is playing so well today!");
addChat("Voter_007", "Don't forget to vote for your favorite!");

// Vote celebration: this is the replacement for the removed community poll test.
setTheme("dark");
voteEvent({ userId: "u99", name: "SuperFan", contestant: 2, candidateName: "Contestant 2" });
drawMainFrame(Date.now());
await writeFile("test-output/dark-vote.png", canvas.toBuffer("image/png"));
console.log("Saved test-output/dark-vote.png");

setTheme("light");
setScreen("race", { manual: false });
drawMainFrame(Date.now() + 500);
await writeFile("test-output/light-race.png", canvas.toBuffer("image/png"));
console.log("Saved test-output/light-race.png");

setTheme("dark");
setScreen("stats", { manual: false });
triggerSpotlight(3, "Benchmark", "Contestant spotlight benchmark.", 10000);
drawMainFrame(Date.now() + 1000);
await writeFile("test-output/dark-stats.png", canvas.toBuffer("image/png"));
console.log("Saved test-output/dark-stats.png");

setTheme("light");
setScreen("events", { manual: false });
drawMainFrame(Date.now() + 1500);
await writeFile("test-output/light-events.png", canvas.toBuffer("image/png"));
console.log("Saved test-output/light-events.png");

console.log("All poll-free test renders successfully completed!");
process.exit(0);
