import { config } from "../src/config.mjs";

async function main() {
  const cRes = await fetch(`https://www.youtube.com/channel/${config.channelId}`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });
  const cHtml = await cRes.text();
  
  const m1 = cHtml.match(/"subscriberCountText":\s*(\{[^}]+\})/);
  if (m1) console.log("subscriberCountText:", m1[1]);

  const m2 = cHtml.match(/"viewCountText":\s*(\{[^}]+\})/);
  if (m2) console.log("viewCountText:", m2[1]);

  const m3 = cHtml.match(/"title":\s*"([^"]+)"/);
  if (m3) console.log("Channel title:", m3[1]);

  // Video watch page
  const vRes = await fetch(`https://www.youtube.com/watch?v=${config.videoId}`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });
  const vHtml = await vRes.text();
  const vm1 = vHtml.match(/"viewCount":\s*"(\d+)"/);
  if (vm1) console.log("Video viewCount:", vm1[1]);

  const vm2 = vHtml.match(/"views":\s*(\{[^}]+\})/);
  if (vm2) console.log("Video views:", vm2[1]);

  const vm3 = vHtml.match(/"shortViewCount":\s*(\{[^}]+\})/);
  if (vm3) console.log("Video shortViewCount:", vm3[1]);

  const vm4 = vHtml.match(/"videoDetails":\s*(\{[^}]+\})/);
  if (vm4) console.log("Video details snippet:", vm4[1].slice(0, 300));
}

main().catch(console.error);
