async function testPublicSub() {
  const url = "https://www.youtube.com/channel/UCUNbognrXqUWzJOtrK8YP2A";
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });
  const html = await res.text();
  const m1 = html.match(/"subscriberCountText":\{[^}]*"simpleText":"([^"]+)"/);
  const m2 = html.match(/"subscriberCountText":\{"accessibility":\{"accessibilityData":\{"label":"([^"]+)"/);
  const m3 = html.match(/([\d.]+[KkMm]?)\s+subscribers/);
  console.log("m1:", m1?.[1]);
  console.log("m2:", m2?.[1]);
  console.log("m3:", m3?.[1]);
}

testPublicSub().catch(console.error);
