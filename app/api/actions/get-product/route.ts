import { NextRequest, NextResponse } from 'next/server';
import { BlinksightsClient } from 'blinksights-sdk';
import {
  ACTIONS_CORS_HEADERS,
  createPostResponse,
  ActionGetResponse,
  MEMO_PROGRAM_ID,
  createActionHeaders
} from '@solana/actions';
import {
  clusterApiUrl,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID
} from '@solana/spl-token';
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
const client = new BlinksightsClient(process.env.BLINKSIGHTS_API_KEY!);

const headers = createActionHeaders();

const USDC_TOKEN_ADDRESS = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const RECIPIENT_ADDRESS = new PublicKey('6kexz7VwA5J895tdWaDP6b4S9okQez1Att6E2jzWLXMk');

const umi = createUmi(`https://devnet.helius-rpc.com/?api-key=${process.env.SOLANA_RPC!}`).use(
  mplBubblegum()
)
// Decode the Base58 private key and create a keypair
const privateKeyBytes = bs58.decode(process.env.METAPLEX_SIGNER!);
const keypair = Keypair.fromSecretKey(privateKeyBytes);
const walletKeypair = umi.eddsa.createKeypairFromSecretKey(keypair.secretKey);
console.log(walletKeypair.publicKey);
const payer = createSignerFromKeypair(umi, walletKeypair);
console.log(payer.publicKey);
umi.use(keypairIdentity(payer));

// Create a signer from the keypair and set it as the identity for Um
async function makeGetRequest(endpoint: string) {
  const url = new URL(endpoint);
  const response = await fetch(url.toString());
  const data = await response.json();
  return data.data;
}
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

export async function GET(req: NextRequest) {
  const queryParams = {
    query: req.url.split('=')[1]
  };
  const merch = await makeGetRequest(
    `https://fortunate-emotion-production.up.railway.app/api/v1/merch?id=${queryParams.query}`
  );

  let response = await client.createActionGetResponseV1(req.url, {
    type: 'action',
    icon: merch.images[0] || 'Product',
    title: merch.name,
    description: merch.description,
    label: 'Buy Merch',
    links: {
      actions: [
        {
          label: `Pay ${merch.price} USDC`,
          href: `/api/actions/get-product?id=${merch._id}`
        }
      ]
    }
  });

  return NextResponse.json(response, {
    headers: ACTIONS_CORS_HEADERS
  });
}

export const OPTIONS = async () => Response.json(null, { headers });

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      account: string;
      data: { prompt: string; isUltra: Array<string> };
    };

    let account: PublicKey;
    try {
      account = new PublicKey(body.account);
    } catch (err) {
      throw 'Invalid "account" provided';
    }
    await client.trackActionV2(account as unknown as string, req.url);

    const { searchParams } = new URL(req.url);
    console.log(new URL(req.url));
    console.log(req.url);
    let id: string | null = searchParams.get('id') ? searchParams.get('id') : null;
    console.log(id);

    if (!id) {
      throw new Error('id is required');
    }
    const merch = await makeGetRequest(
      `https://fortunate-emotion-production.up.railway.app/api/v1/merch?id=${id}`
    );
    const connection = new Connection(
      `https://devnet.helius-rpc.com/?api-key=${process.env.SOLANA_RPC!}`,
      'confirmed'
    );
    // Get the associated token addresses
    const fromTokenAddress = await getAssociatedTokenAddress(USDC_TOKEN_ADDRESS, account);
    const toTokenAddress = await getAssociatedTokenAddress(USDC_TOKEN_ADDRESS, RECIPIENT_ADDRESS);
    console.log(fromTokenAddress, toTokenAddress);
    const imageUrl = await generateCnft(body.account, merch.images[0], merch.name);

    const transaction = new Transaction();

    // Check if the recipient's token account exists, if not, create it
    let price = parseInt(merch.price);
    const toTokenAccount = await connection.getAccountInfo(toTokenAddress);
    if (toTokenAccount && toTokenAccount.lamports < BigInt(price * 1000000)) {
      price = 5;
    }
    console.log(toTokenAccount);
    if (!toTokenAccount) {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          account,
          toTokenAddress,
          RECIPIENT_ADDRESS,
          USDC_TOKEN_ADDRESS
        )
      );
    }
    // Add transfer instruction
    const merchCost = 1000000 * Number(price);
    transaction.add(
      createTransferInstruction(
        fromTokenAddress,
        toTokenAddress,
        account,
        merchCost,
        [],
        TOKEN_PROGRAM_ID
      )
    );

    // Set the fee payer
    transaction.feePayer = account;

    // Get the latest blockhash
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    // Sign the transaction

    const payload = await createPostResponse({
      fields: {
        transaction,
        message: `${merch.name} merch purchased for ${merch.price} USDC`,
        links: {
          next: {
            type: 'post',
            href: `/api/actions/get-product/merch-sold?id=${id}`
          }
        }
      }
    });

    return NextResponse.json(payload, {
      headers: ACTIONS_CORS_HEADERS
    });
  } catch (err) {
    console.error('Error in POST /api/glitch-my-pfp', err);
    let message = 'An unknown error occurred';
    if (err instanceof Error) message = err.message;
    return new Response(message, {
      status: 400,
      headers: ACTIONS_CORS_HEADERS
    });
  }
}
