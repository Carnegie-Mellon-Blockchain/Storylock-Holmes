import {
  EResourceType,
  FetcherService,
  IUserNotificationsResponse,
  Rettiwt,
  User,
} from "rettiwt-api";
import { IAgentRuntime, settings } from "@elizaos/core";
import readline from "readline";

interface TweetThread {
  tweetId: string;
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

    thread.push({
      tweetId: id,
      tweetFullText: tweet.fullText,
      createdAt_str: tweet.createdAt,
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
      const lastTweet = thread[thread.length - 1];

      if (lastTweet.tweetBy.userName === process.env.TWITTER_USERNAME) {
        console.log("Skipping reply to self");
        continue;
      }

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

      const data = await response.json();
      console.log({ data });

      // Post each response as a reply tweet
      for (const message of data) {
        // const tweetId = await rettiwt.tweet.post({
        //   text: message.text,
        //   replyTo: lastTweetId,
        // });
        const twitterClient = await runtime.clients[0];
        const tweetId = await twitterClient.post.quickReply(
          lastTweet.tweetId,
          message.text
        );
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
