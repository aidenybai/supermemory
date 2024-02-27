import type {
	VectorizeIndex,
	Fetcher,
	Request,
} from "@cloudflare/workers-types";

import {
	CloudflareVectorizeStore,
	CloudflareWorkersAIEmbeddings,
} from "@langchain/cloudflare";
import { Ai } from '@cloudflare/ai';

export interface Env {
	VECTORIZE_INDEX: VectorizeIndex;
	AI: Fetcher;
	SECURITY_KEY: string
}


function isAuthorized(request: Request, env: Env): boolean {
	return request.headers.get('X-Custom-Auth-Key') === env.SECURITY_KEY;
}

export default {
	async fetch(request: Request, env: Env) {
		if (!isAuthorized(request, env)) {
			return new Response('Unauthorized', { status: 401 });
		}

		const pathname = new URL(request.url).pathname;
		const embeddings = new CloudflareWorkersAIEmbeddings({
			binding: env.AI,
			modelName: "@cf/baai/bge-small-en-v1.5",
		});
		const store = new CloudflareVectorizeStore(embeddings, {
			index: env.VECTORIZE_INDEX,
		});
		const ai = new Ai(env.AI)


		if (pathname === "/add" && request.method === "POST") {
			const body = await request.json() as {
				pageContent: string,
				title?: string,
				description?: string,
				url: string,
				user: string
			};

			if (!body.pageContent || !body.url) {
				return new Response(JSON.stringify({ message: "Invalid Page Content" }), { status: 400 });
			}


			await store.addDocuments([
				{
					pageContent: body.pageContent,
					metadata: {
						title: body.title ?? "",
						description: body.description ?? "",
						url: body.url,
						user: body.user,
					},
				}
			])

			return new Response(JSON.stringify({ message: "Document Added" }), { status: 200 });
		}

		else if (pathname === "/query" && request.method === "GET") {
			const queryparams = new URL(request.url).searchParams;
			const query = queryparams.get("q");
			const topK = parseInt(queryparams.get("topK") ?? "5");
			const user = queryparams.get("user")
			if (!user) {
				return new Response(JSON.stringify({ message: "Invalid User" }), { status: 400 });
			}

			if (!query) {
				return new Response(JSON.stringify({ message: "Invalid Query" }), { status: 400 });
			}

			const filter: VectorizeVectorMetadataFilter = {
				user: {
					$eq: user
				}
			}

			const resp = await store.similaritySearch(query, topK, filter)

			if (resp.length ===0) {
				return new Response(JSON.stringify({ message: "No Results Found" }), { status: 400 });
			}

			const output = await ai.run('@cf/meta/llama-2-7b-chat-int8', {
				prompt: `You are an agent that summarizes a page based on the query. Be direct and concise, don't say 'based on the context'.\n\n Context:\n${JSON.stringify(resp)} \nAnswer this question based on the context. Question: ${query}`,
			})

			return new Response(JSON.stringify(output), { status: 200 });
		}
	},
};
