import axios from 'axios';
import twilio from 'twilio';

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

function verifyTwilioSignature(req) {
  const twilioSignature = req.headers['x-twilio-signature'] || '';
  const url = `${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'http://localhost:3000'}/api/twilio-to-slack`;
  
  let body = '';
  if (typeof req.body === 'string') {
    body = req.body;
  } else {
    const keys = Object.keys(req.body).sort();
    keys.forEach(key => {
      body += key + req.body[key];
    });
  }

  const hash = twilio.webhook(TWILIO_AUTH_TOKEN, twilioSignature, url, body);
  return hash === twilioSignature;
}

function escapeSlackText(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!verifyTwilioSignature(req)) {
      console.warn('Invalid Twilio signature');
      return res.status(403).send('Unauthorized');
    }

    const { From, Body, MessageSid, NumMedia } = req.body;

    if (!From || !Body || !MessageSid) {
      console.error('Missing required Twilio fields');
      return res.status(400).send('Missing required fields');
    }

    console.log(`Received SMS from ${From}: ${Body}`);

    const slackMessage = {
      channel: SLACK_CHANNEL_ID,
      text: `📱 *SMS from ${From}*`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*SMS from:* ${From}\\n*Message:* ${escapeSlackText(Body)}`,
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Message ID: ${MessageSid} | ${new Date().toLocaleString()}`,
            },
          ],
        },
      ],
      metadata: {
        event_type: 'sms_received',
        event_payload: {
          twilio_message_sid: MessageSid,
          phone_from: From,
        },
      },
    };

    if (NumMedia && parseInt(NumMedia) > 0) {
      slackMessage.blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `📎 ${NumMedia} attachment(s) received`,
        },
      });
    }

    const slackResponse = await axios.post(
      'https://slack.com/api/chat.postMessage',
      slackMessage,
      {
        headers: {
          'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!slackResponse.data.ok) {
      throw new Error(`Slack API error: ${slackResponse.data.error}`);
    }

    console.log(`Posted to Slack: ${slackResponse.data.ts}`);

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>SMS received and forwarded to Slack</Message>
</Response>`;

    res.setHeader('Content-Type', 'application/xml');
    return res.status(200).send(twimlResponse);

  } catch (error) {
    console.error('Error in twilio-to-slack:', error.message);
    const errorTwiML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>Error processing your message. Please try again.</Message>
</Response>`;
    res.setHeader('Content-Type', 'application/xml');
    return res.status(200).send(errorTwiML);
  }
}
