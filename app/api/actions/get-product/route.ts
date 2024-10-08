import * as fal from '@fal-ai/serverless-client';
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

fal.config({
  credentials: process.env.FAL_AI_API_KEY
});

const client = new BlinksightsClient(process.env.BLINKSIGHTS_API_KEY!);

const headers = createActionHeaders();

const USDC_TOKEN_ADDRESS = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const RECIPIENT_ADDRESS = new PublicKey('6kexz7VwA5J895tdWaDP6b4S9okQez1Att6E2jzWLXMk');

async function makeGetRequest(endpoint: string, queryParams: Record<string, string>) {
  const url = new URL(endpoint);
  const response = await fetch(url.toString());
  const data = await response.json();
  return data.data;
}

export async function GET(req: NextRequest) {
  const queryParams = {
    query: req.url.split('=')[1]
  };
  const merch = await makeGetRequest(
    `https://fortunate-emotion-production.up.railway.app/api/v1/merch?id=${queryParams.query}`,
    queryParams
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
          href: `/api/actions/get-product?price=${merch.price}`
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
    console.log(searchParams);
    const price = searchParams.get('price');
    console.log(price);

    if (!price) {
      throw new Error('price is required');
    }

    const connection = new Connection(
      `https://devnet.helius-rpc.com/?api-key=${process.env.SOLANA_RPC!}`,
      'confirmed'
    );
    // Get the associated token addresses
    const fromTokenAddress = await getAssociatedTokenAddress(USDC_TOKEN_ADDRESS, account);
    const toTokenAddress = await getAssociatedTokenAddress(USDC_TOKEN_ADDRESS, RECIPIENT_ADDRESS);
    console.log(fromTokenAddress, toTokenAddress);

    const transaction = new Transaction();

    // Check if the recipient's token account exists, if not, create it
    const toTokenAccount = await connection.getAccountInfo(toTokenAddress);
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
    const merchCost = 10000000; // calculate cost based on isUltra
    transaction.add(
      createTransferInstruction(
        fromTokenAddress,
        toTokenAddress,
        account,
        merchCost, // 10 SEND tokens (assuming 9 decimals)
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
        message: `Image generated successfully`,
        links: {
          next: {
            type: 'post',
            href: `/api/actions/glitch-my-pfp/create-nft?url=${`https://google.com`}`
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
