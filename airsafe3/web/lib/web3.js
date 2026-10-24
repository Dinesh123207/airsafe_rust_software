// Wallet helpers (EIP-1193 `window.ethereum`, no library): Sign-In with Ethereum for AIRSAFE accounts.
import { api } from './api';

export const hasWallet = () => typeof window !== 'undefined' && Boolean(window.ethereum);

const utf8Hex = (s) => '0x' + [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function walletAuth({ role, vertical_access } = {}) {
  if (!hasWallet()) throw new Error('No Ethereum wallet found. Install MetaMask (or any EIP-1193 wallet) and reload.');
  const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
  const address = accounts && accounts[0];
  if (!address) throw new Error('The wallet did not share an account.');
  // 1. the server issues a single-use EIP-4361 message (10 minute lifetime)
  const { nonce, message } = await api('/api/auth/wallet/nonce', { method: 'POST', body: { address }, auth: false });
  // 2. the wallet signs it (personal_sign, free, no transaction)
  const signature = await window.ethereum.request({ method: 'personal_sign', params: [utf8Hex(message), address] });
  // 3. the server recovers the signer from the signature and issues the same JWT as email login
  return api('/api/auth/wallet/verify', { method: 'POST', body: { address, nonce, signature, role, vertical_access }, auth: false });
}

export const shortHash = (h, n = 8) => (h && h.length > 2 * n + 2 ? `${h.slice(0, n + 2)}…${h.slice(-n)}` : h || '');
