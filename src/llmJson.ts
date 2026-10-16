/** Parse JSON from an LLM reply, tolerating code fences and surrounding prose */
export const parseLLMJson = (raw: string) => {
  const cleaned = raw.replace(/```(?:json)?\s*\n?/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('No JSON object in LLM response');
    return JSON.parse(cleaned.slice(start, end + 1));
  }
};
