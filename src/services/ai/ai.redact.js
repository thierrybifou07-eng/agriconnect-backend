const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/g;
const URL_RE = /(?:https?:\/\/|www\.)[^\s<>'"()]+/gi;
const EMAIL_RE = /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g;

function maskPhone(value) {
  if (!value) return value;
  const candidate = value.trim();
  if (/\b(?:XAF|FCFA|CDF|USD|EUR|CFA)\b/i.test(candidate)) return value;
  return '[téléphone]';
}

export function redactClientBlocks(userPrompt) {
  if (!userPrompt || typeof userPrompt !== 'string') return userPrompt;

  return userPrompt.replace(/<message_client>([\s\S]*?)<\/message_client>/gi, (_, inner) => {
    let content = inner;
    const amounts = new Map();

    content = content.replace(/\b\d[\d\s.,]*\s*(?:XAF|FCFA|CDF|USD|EUR|CFA)\b/gi, (match) => {
      const token = `__AI_AMOUNT_${amounts.size}__`;
      amounts.set(token, match);
      return token;
    });

    content = content.replace(EMAIL_RE, '[e-mail]');
    content = content.replace(URL_RE, '[lien]');
    content = content.replace(PHONE_RE, (match) => maskPhone(match));
    for (const [token, value] of amounts) {
      content = content.replace(token, value);
    }

    return `<message_client>${content}</message_client>`;
  });
}
