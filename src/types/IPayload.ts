// src/types/IPayload.ts
export interface IPayload {
  author: string;
  description: string;
  image: string;
  ipId: string;
  ipMetadataHash: string;
  ipMetadataURI: string;
  ipUrl: string;
  nftMetadataHash: string;
  nftMetadataURI: string;
  permanentUrl: string;
  timestamp: string;
  title: string;
  tokenId: number;
  txHash: string;
  type: string;
  score?: number;
}
