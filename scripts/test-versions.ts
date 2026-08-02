async function testVersions() {
  const versions = ['v1', 'v1beta', 'v1alpha'];
  const model = process.env.GEMINI_VERSION || 'gemini-3-flash';
  const key = process.env.GEMINI_API_KEY;

  for (const v of versions) {
    console.log(`Testing version ${v} with model ${model}...`);
    try {
      const resp = await fetch(`https://generativelanguage.googleapis.com/${v}/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-goog-api-key': key || ""
        },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'Hi' }] }] })
      });
      const data = await resp.json();
      if (resp.ok) {
        console.log(`SUCCESS with ${v}!`);
        return;
      } else {
        console.log(`FAILED with ${v}: ${resp.status} ${resp.statusText}`);
        console.log(JSON.stringify(data, null, 2));
      }
    } catch (e: any) {
      console.log(`ERROR with ${v}: ${e.message}`);
    }
  }
}

testVersions();
