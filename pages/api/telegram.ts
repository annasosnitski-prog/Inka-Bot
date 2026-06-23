import type { NextApiRequest, NextApiResponse } from 'next';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, info: 'inka-bot webhook alive' });
  }

  console.log('Incoming Telegram update:', JSON.stringify(req.body));

  return res.status(200).json({ ok: true });
}
