import {
  createActionHeaders,
  NextActionPostRequest,
  ActionError,
  CompletedAction
} from '@solana/actions';
import { clusterApiUrl, Connection, Keypair, PublicKey } from '@solana/web3.js';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import {
  createTree,
  fetchMerkleTree,
  LeafSchema,
  mintV1,
  mplBubblegum,
  parseLeafFromMintV1Transaction
} from '@metaplex-foundation/mpl-bubblegum';
import {
  createSignerFromKeypair,
  keypairIdentity,
  none,
  publicKey,
  signerIdentity
} from '@metaplex-foundation/umi';
import bs58 from 'bs58';

// create the standard headers for this route (including CORS)
const headers = createActionHeaders();

const connection = new Connection(
  `https://devnet.helius-rpc.com/?api-key=${process.env.SOLANA_RPC!}`,
  'confirmed'
);
const umi = createUmi(`https://devnet.helius-rpc.com/?api-key=${process.env.SOLANA_RPC!}`).use(
  mplBubblegum()
);
/**
 * since this endpoint is only meant to handle the callback request
 * for the action chaining, it does not accept or process GET requests
 */
// Decode the Base58 private key and create a keypair
const privateKeyBytes = bs58.decode(process.env.METAPLEX_SIGNER!);
const keypair = Keypair.fromSecretKey(privateKeyBytes);
const walletKeypair = umi.eddsa.createKeypairFromSecretKey(keypair.secretKey);
console.log(walletKeypair.publicKey);
const payer = createSignerFromKeypair(umi, walletKeypair);
console.log(payer.publicKey);
umi.use(keypairIdentity(payer));

async function generateCnft(recipient: any, imageUrl: string, name: string) {
  const merkleTreePublicKey = publicKey('Df2vbbooX1u2L8nfaA8cjzZzbsZsNVokA8YKrabk6Y8o');
  const merkleTreeAccount = await fetchMerkleTree(umi, merkleTreePublicKey);

  const { signature } = await mintV1(umi, {
    leafOwner: recipient,
    merkleTree: merkleTreeAccount.publicKey,
    metadata: {
      name,
      uri: imageUrl,
      sellerFeeBasisPoints: 500, // 5%
      collection: none(),
      creators: [{ address: umi.identity.publicKey, verified: false, share: 100 }]
    }
  }).sendAndConfirm(umi, { confirm: { commitment: 'finalized' } });

  const leaf: LeafSchema = await parseLeafFromMintV1Transaction(umi, signature);

  const rpc = umi.rpc as any;
  const rpcAsset = await rpc.getAsset(leaf.id);
  console.log(rpcAsset);
  return rpcAsset.content.json_uri;
}
export const GET = async (req: Request) => {
  return Response.json({ message: 'Method not supported' } as ActionError, {
    status: 403,
    headers
  });
};

export const OPTIONS = async () => Response.json(null, { headers });

async function confirmTransaction(
  connection: Connection,
  signature: string,
  maxRetries = 5,
  retryDelay = 5000
) {
  for (let i = 0; i < maxRetries; i++) {
    const status = await connection.getSignatureStatus(signature);
    console.log('Signature status:', status);

    if (
      status?.value?.confirmationStatus === 'confirmed' ||
      status?.value?.confirmationStatus === 'finalized'
    ) {
      return true;
    }

    if (status?.value?.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`);
    }

    await new Promise((resolve) => setTimeout(resolve, retryDelay));
  }

  throw new Error('Transaction confirmation timeout');
}
async function makeGetRequest(endpoint: string) {
  const url = new URL(endpoint);
  const response = await fetch(url.toString());
  const data = await response.json();
  return data.data;
}

export const POST = async (req: Request) => {
  try {
    const { searchParams } = new URL(req.url);
    const merchId = searchParams.get('id');
    console.log('merchId:', merchId);

    const merch = await makeGetRequest(
      `https://fortunate-emotion-production.up.railway.app/api/v1/merch?id=${merchId}`
    );
    /**
     * we can type the `body.data` to what fields we expect from the GET response above
     */
    const body: NextActionPostRequest = await req.json();

    console.log('body:', body);

    let account: PublicKey;
    try {
      account = new PublicKey(body.account);
    } catch (err) {
      throw 'Invalid "account" provided';
    }
        const imageUrl = await generateCnft(new PublicKey(account), merch.images[0], merch.name);

    let signature: string;
    try {
      signature = body.signature;
      if (!signature) throw 'Invalid signature';
    } catch (err) {
      throw 'Invalid "signature" provided';
    }

    // In your POST function:
    try {
      await confirmTransaction(connection, signature);
      // Proceed with creating the payload
    } catch (error) {
      console.error('Transaction confirmation failed:', error);
      throw 'Unable to confirm the transaction';
    }

    const payload: CompletedAction = {
      type: 'completed',
      title: 'Coinswag',
      icon: new URL(merch.images[0]).toString(),
      label: `Paid ${merch.price} USDC`,
      description: `Successfully paid for ${merch.name}. Please continue with this link: https://degods.coinswag.shop/checkout`
    };

    return Response.json(payload, {
      headers
    });
  } catch (err) {
    let actionError: ActionError = { message: 'An unknown error occurred' };
    if (typeof err == 'string') actionError.message = err;
    return Response.json(actionError, {
      status: 400,
      headers
    });
  }
};
