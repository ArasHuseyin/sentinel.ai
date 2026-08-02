import dotenv from 'dotenv';
dotenv.config();

async function listModels() {
  const result = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`);
  const models = await result.json();
  console.log(JSON.stringify(models, null, 2));
}

listModels();
