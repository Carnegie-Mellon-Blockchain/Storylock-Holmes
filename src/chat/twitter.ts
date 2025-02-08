import {
  EResourceType,
  FetcherService,
  IUserNotificationsResponse,
  Rettiwt,
  User,
} from "rettiwt-api";
import { IAgentRuntime, settings } from "@elizaos/core";
import readline from "readline";
import { IPayload } from "../types/IPayload";

interface TweetThread {
  tweetId: string;
  tweetMediaUrls: string[] | undefined;
  tweetFullText: string | undefined;
  tweetReplyTo: string | undefined;
  tweetBy: User;
  createdAt_str: string | undefined;
  createdAt: Date | undefined;
}

async function getFullThread(
  rettiwt: Rettiwt,
  tweetId: string
): Promise<TweetThread[]> {
  const thread: TweetThread[] = [];

  async function collectReplies(id: string) {
    const tweet = await rettiwt.tweet.details(id);

    if (!tweet) return;

    let mediaUrls = undefined;
    if (tweet.media && tweet.media[0]?.type === "photo") {
      mediaUrls = tweet.media.map((m) => m.url);
    }
    thread.push({
      tweetId: id,
      tweetFullText: tweet.fullText,
      createdAt_str: tweet.createdAt,
      tweetMediaUrls: mediaUrls,
      createdAt: new Date(tweet.createdAt),
      tweetReplyTo: tweet.replyTo,
      tweetBy: tweet.tweetBy,
    });

    if (tweet.replyTo) {
      await collectReplies(tweet.replyTo);
    }
  }

  await collectReplies(tweetId);
  thread.sort((a, b) => {
    if (!a.createdAt || !b.createdAt) return 0;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
  return thread;
}

export function startTwitterChat(characters: any[], runtime: IAgentRuntime) {
  const handledTweetIds: string[] = [];
  const rettiwt = new Rettiwt({ apiKey: process.env["TWITTER_COOKIES"] });
  const fetcher = new FetcherService({
    apiKey: process.env["TWITTER_COOKIES"],
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.on("SIGINT", () => {
    rl.close();
    process.exit(0);
  });

  async function handleNewTweets(
    tweets: Record<string, any>,
    is_initial: boolean = false
  ) {
    for (const [id, value] of Object.entries(tweets)) {
      if (handledTweetIds.includes(id)) continue;
      handledTweetIds.push(id);
      if (is_initial) continue;

      const thread = await getFullThread(rettiwt, (value as any).id_str);

      // Update lastTweetId to the tweet we're replying to
      let lastTweet = thread[thread.length - 1];
      let previousTweet;
      if (thread.length > 1) {
        previousTweet = thread[thread.length - 2];
      }

      if (lastTweet.tweetBy.userName === process.env.TWITTER_USERNAME) {
        console.log("Skipping reply to self");
        continue;
      }

      let replyData;
      if (previousTweet?.tweetMediaUrls?.length > 0) {
        // let latestMediaTweet = thread.find(
        //   (tweet) => tweet.tweetMediaUrls?.length > 0
        // );
        // console.log({ latestMediaTweet });
        // TODO: 1. 用 LLM 檢查他是不是要幫忙 check IP.
        // 如果不是則正常回應 (下方的 else)
        // 如果是，就送去 Kai 的 API，回傳相似。如果有相似超過 threadhold 就打印出相似，沒有就說沒有。
        // Eason 會加上「前端可以註冊 IP」
        // Check if image is registered as IP via Storylock API

        try {
          const response = await fetch(
            `https://storylock.vercel.app/api/x/post/${previousTweet.tweetId}/check`
          );

          const data = await response.json();

          const filteredResults = data.checkResult.results
            ?.filter((result: any) => result.score > 0.8)
            .map((result: any) => ({
              ...result.payload,
              score: result.score,
            })) as IPayload[];
          console.log({ filteredResults });

          if (filteredResults && filteredResults.length > 0) {
            replyData = [
              {
                text:
                  "I found some similar content that is registered as IP at Story Protocol:\n\n" +
                  filteredResults
                    .map(
                      (item: IPayload) =>
                        `- ${Math.round(item.score * 100)}%: ${item.ipUrl}`
                    )
                    .join("\n") +
                  `\n\nCheck it out at https://storylock.vercel.app/xcheck?pid=${previousTweet.tweetId}`,
              },
            ];
          } else {
            replyData = [
              {
                text: `I didn't find any similar registered content.\n\nYou can register this as new IP at https://storylock.vercel.app/xupload?pid=${previousTweet.tweetId}.`,
              },
            ];
          }
        } catch (error) {
          console.error("Error checking IP:", error);
          replyData = [
            {
              text: "Sorry, I encountered an error while checking for IP registration.",
            },
          ];
        }
        // TODO: Add a check for the IP address.
      } else {
        let conversation = "";
        for (const tweet of thread) {
          conversation += `${tweet.tweetBy.fullName} (@${tweet.tweetBy.userName}): ${tweet.tweetFullText}\n`;
        }

        const serverPort = parseInt(settings.SERVER_PORT || "3000");
        const agentId = characters[0].name ?? "Agent";
        console.log(conversation);

        // Get AI response for the tweet
        const response = await fetch(
          `http://localhost:${serverPort}/${agentId}/message`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text: conversation,
              userId: lastTweet.tweetBy.fullName,
              userName: lastTweet.tweetBy.fullName,
            }),
          }
        );

        replyData = await response.json();
      }
      console.log({ replyData });

      // Post each response as a reply tweet
      let tweetId = lastTweet.tweetId;
      for (const message of replyData) {
        // const tweetId = await rettiwt.tweet.post({
        //   text: message.text,
        //   replyTo: lastTweetId,
        // });
        const twitterClient = await runtime.clients[0];
        tweetId = await twitterClient.post.quickReply(tweetId, message.text);
        setTimeout(async () => {
          await twitterClient.post.likeTweet(lastTweet.tweetId);
        }, 1000 + Math.floor(Math.random() * 10000));
      }
    }
  }

  async function startNotificationStream() {
    try {
      const initialResponse = await fetcher.request<IUserNotificationsResponse>(
        EResourceType.USER_NOTIFICATIONS,
        {}
      );
      await handleNewTweets(
        (initialResponse.globalObjects as any).tweets,
        true
      );

      for await (const notification of rettiwt.user.notifications(10000)) {
        const response = await fetcher.request<IUserNotificationsResponse>(
          EResourceType.USER_NOTIFICATIONS,
          {}
        );
        await handleNewTweets((response.globalObjects as any).tweets);
      }
    } catch (error) {
      console.error("Error in notification stream:", error);
      // Restart the stream on error
      startNotificationStream();
    }
  }

  // Start the notification stream
  startNotificationStream();

  // Return cleanup function (note: the stream will need to be manually closed if implemented)
  return () => {
    // Cleanup logic if needed
  };
}
