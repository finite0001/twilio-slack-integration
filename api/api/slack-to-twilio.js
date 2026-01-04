import axios from 'axios';
import twilio from 'twilio';
import crypto from 'crypto';

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

function verifySlackSignature(req) {
  const signature = req.headers['x-slack-request-signature'];
  const timestamp = req.headers['x-slack-request-timestamp'];

  if (!signature || !timestamp) {
    console.warn('Missing Slack signature or timestamp');
    return false;
  }

  const time = Math.floor(Date.now() / 1000);
  if (Math.abs(time - parseInt(timestamp)) > 300) {
    console.warn('Slack request timestamp too old');
    return false;
  }

  const baseString = `v0:${timestamp}:${JSON.stringify(req.body)}`;
  const hmac = crypto.createHmac('sha256', SLACK_SIGNING_SECRET);
  hmac.update(baseString);
  const computedSignature = `v0=${hmac.digest('hex')}`;

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(computedSignature)
  );
}

async function getThreadInfo(channel, ts) {
  try {
    const response = await axios.get(
      'https://slack.com/api/conversations.replies',
      {
        params: {
          channel,
          ts,
          limit: 1,
        },
        headers: {
          'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
        },
      }
    );

    if (!response.data.ok || !response.data.messages[0]) {
      throw new Error('Could not fetch thread');
    }

    const originalMessage = response.data.messages[0];
    const metadata = originalMessage.metadata;

    if (metadata?.event_payload?.phone_from) {
      return {
        phoneNumber: metadata.event_payload.phone_from,
        messageSid: metadata.event_payload.twilio_message_sid,
      };
    }

    const phoneMatch = originalMessage.text?.match(/SMS from ([+\\d\\s\\-\\(\\)]+)/);
    if (phoneMatch) {
      return {
        phoneNumber: phoneMatch[1].trim(),
        messageSid: null,
      };
    }

    throw new Error('No phone number found');

  } catch (error) {
    console.error('Error getting thread info:', error.message);
    return { phoneNumber: null, messageSid: null };
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const { type, challenge, event } = req.body;

    if (type === 'url_verification') {
      console.log('Slack URL verification challenge');
      return res.json({ challenge });
    }

    if (!verifySlackSignature(req)) {
      console.warn('Invalid Slack signature');
      return res.status(403).json({ error: 'Unauthorized' });
    }

    if (type !== 'event_callback') {
      return res.status(200).json({ ok: true });
    }

    const { subtype, channel, user, text, thread_ts, ts } = event;

    if (subtype === 'bot_message' || !text || text.length === 0) {
      return res.status(200).json({ ok: true });
    }

    if (channel !== SLACK_CHANNEL_ID) {
      return res.status(200).json({ ok: true });
    }

    console.log(`Received Slack message: ${text}`);

    const threadInfo = await getThreadInfo(channel, thread_ts || ts);
    
    if (!threadInfo.phoneNumber) {
      console.error('Could not find phone number in thread');
      return res.status(200).json({ ok: true });
    }

    const message = await twilioClient.messages.create({
      from: TWILIO_PHONE_NUMBER,
      to: threadInfo.phoneNumber,
      body: text,
    });

    console.log(`Sent SMS: ${message.sid}`);

    await axios.post(
      'https://slack.com/api/reactions.add',
      {
        channel,
        name: 'white_check_mark',
        timestamp: ts,
      },
      {
        headers: {
          'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
        },
      }
    );

    const confirmationMessage = `✅ SMS delivered to ${threadInfo.phoneNumber}\\nTwilio MessageSid: ${message.sid}`;
    
    await axios.post(
      'https://slack.com/api/chat.postMessage',
      {
        channel,
        thread_ts: thread_ts || ts,
        text: confirmationMessage,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: confirmationMessage,
            },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `Sent at ${new Date().toLocaleString()}`,
              },
            ],
          },
        ],
      },
      {
        headers: {
          'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
        },
      }
    );

    return res.status(200).json({ ok: true });

  } catch (error) {
    console.error('Error in slack-to-twilio:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
