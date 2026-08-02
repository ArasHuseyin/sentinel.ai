import dotenv from 'dotenv';
dotenv.config();

async function listAllModels() {
  const key = process.env.GEMINI_API_KEY;
  const versions = ['v1', 'v1beta', 'v1alpha'];
  
  for (const v of versions) {
    try {
      console.log(`Checking models in ${v}...`);
      const resp = await fetch(`https://generativelanguage.googleapis.com/${v}/models?key=${key}`);
      const data = await resp.json();
      if (data.models) {
        data.models.forEach((m: any) => {
          if (m.name.includes('flash') || m.name.includes('3')) {
            console.log(`- ${m.name} (${m.displayName})`);
          }
        });
      }
    } catch (e: any) {
      console.log(`Error in ${v}: ${e.message}`);
    }
  }
}

listAllModels();
