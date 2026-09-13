import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// Public STUN only, for every user regardless of plan. The Pro/TURN gate
// (Metered.ca or any other provider) is paused for now — see git history
// for that implementation if/when it's picked back up. No provider
// credentials of any kind live in this file.
const STUN_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

router.get('/ice-servers', requireAuth, (req, res) => {
  res.json({ iceServers: STUN_SERVERS, turnAvailable: false });
});

export default router;
