import fs from 'fs';
import path from 'path';
import { lookup as mimeLookup } from 'mime-types';
import nodemailer from 'nodemailer';

/**
 * Helper function to encode email headers containing non-ASCII characters
 * according to RFC 2047 MIME specification
 */
function encodeEmailHeader(text: string): string {
    // Only encode if the text contains non-ASCII characters
    if (/[^\x00-\x7F]/.test(text)) {
        // Use MIME Words encoding (RFC 2047)
        return '=?UTF-8?B?' + Buffer.from(text).toString('base64') + '?=';
    }
    return text;
}

export const validateEmail = (email: string): boolean => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
};

export function createEmailMessage(validatedArgs: any): string {
    const encodedSubject = encodeEmailHeader(validatedArgs.subject);
    // Determine content type based on available content and explicit mimeType
    let mimeType = validatedArgs.mimeType || 'text/plain';
    
    // If htmlBody is provided and mimeType isn't explicitly set to text/plain,
    // use multipart/alternative to include both versions
    if (validatedArgs.htmlBody && mimeType !== 'text/plain') {
        mimeType = 'multipart/alternative';
    }

    // Generate a random boundary string for multipart messages
    const boundary = `----=_NextPart_${Math.random().toString(36).substring(2)}`;

    // Validate email addresses
    (validatedArgs.to as string[]).forEach(email => {
        if (!validateEmail(email)) {
            throw new Error(`Recipient email address is invalid: ${email}`);
        }
    });

    // Common email headers
    const emailParts = [
        'From: me',
        `To: ${validatedArgs.to.join(', ')}`,
        validatedArgs.cc ? `Cc: ${validatedArgs.cc.join(', ')}` : '',
        validatedArgs.bcc ? `Bcc: ${validatedArgs.bcc.join(', ')}` : '',
        `Subject: ${encodedSubject}`,
        // Add thread-related headers if specified
        validatedArgs.inReplyTo ? `In-Reply-To: ${validatedArgs.inReplyTo}` : '',
        validatedArgs.inReplyTo ? `References: ${validatedArgs.inReplyTo}` : '',
        'MIME-Version: 1.0',
    ].filter(Boolean);

    // Construct the email based on the content type
    if (mimeType === 'multipart/alternative') {
        // Multipart email with both plain text and HTML
        emailParts.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
        emailParts.push('');
        
        // Plain text part
        emailParts.push(`--${boundary}`);
        emailParts.push('Content-Type: text/plain; charset=UTF-8');
        emailParts.push('Content-Transfer-Encoding: 7bit');
        emailParts.push('');
        emailParts.push(validatedArgs.body);
        emailParts.push('');
        
        // HTML part
        emailParts.push(`--${boundary}`);
        emailParts.push('Content-Type: text/html; charset=UTF-8');
        emailParts.push('Content-Transfer-Encoding: 7bit');
        emailParts.push('');
        emailParts.push(validatedArgs.htmlBody || validatedArgs.body); // Use body as fallback
        emailParts.push('');
        
        // Close the boundary
        emailParts.push(`--${boundary}--`);
    } else if (mimeType === 'text/html') {
        // HTML-only email
        emailParts.push('Content-Type: text/html; charset=UTF-8');
        emailParts.push('Content-Transfer-Encoding: 7bit');
        emailParts.push('');
        emailParts.push(validatedArgs.htmlBody || validatedArgs.body);
    } else {
        // Plain text email (default)
        emailParts.push('Content-Type: text/plain; charset=UTF-8');
        emailParts.push('Content-Transfer-Encoding: 7bit');
        emailParts.push('');
        emailParts.push(validatedArgs.body);
    }

    return emailParts.join('\r\n');
}


export async function createEmailWithNodemailer(validatedArgs: any): Promise<string> {
    // Validate email addresses
    (validatedArgs.to as string[]).forEach(email => {
        if (!validateEmail(email)) {
            throw new Error(`Recipient email address is invalid: ${email}`);
        }
    });

    // Create a nodemailer transporter (we won't actually send, just generate the message)
    const transporter = nodemailer.createTransport({
        streamTransport: true,
        newline: 'unix',
        buffer: true
    });

    // Prepare attachments for nodemailer
    const attachments = [];
    for (const filePath of validatedArgs.attachments) {
        if (!fs.existsSync(filePath)) {
            throw new Error(`File does not exist: ${filePath}`);
        }
        
        const fileName = path.basename(filePath);
        
        attachments.push({
            filename: fileName,
            path: filePath
        });
    }

    const mailOptions = {
        from: 'me', // Gmail API will replace this with the authenticated user
        to: validatedArgs.to.join(', '),
        cc: validatedArgs.cc?.join(', '),
        bcc: validatedArgs.bcc?.join(', '),
        subject: validatedArgs.subject,
        text: validatedArgs.body,
        html: validatedArgs.htmlBody,
        attachments: attachments,
        inReplyTo: validatedArgs.inReplyTo,
        references: validatedArgs.inReplyTo
    };

    // Generate the raw message
    const info = await transporter.sendMail(mailOptions);
    const rawMessage = info.message.toString();
    
    return rawMessage;
}

// Drop this somewhere in your MCP server code
export function makeEmailBodyLLMSafe(payload: any, opts?: { maxChars?: number; }): string {
  const MAX_CHARS = opts?.maxChars ?? 6000;

  // ---------- helpers ----------
  const decodeBody = (data?: string): string => {
    if (!data) return '';
    // Gmail uses URL-safe base64
    const buff = Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return buff.toString('utf8');
  };

  // Recursively extract text + html
  const extract = (part: any): { text: string; html: string } => {
    let text = '';
    let html = '';

    if (!part) return { text, html };

    const mime = part.mimeType;

    if (mime === 'text/plain' && part.body?.data) {
      text += decodeBody(part.body.data);
    } else if (mime === 'text/html' && part.body?.data) {
      html += decodeBody(part.body.data);
    }

    if (Array.isArray(part.parts)) {
      for (const p of part.parts) {
        const child = extract(p);
        text += child.text;
        html += child.html;
      }
    }

    return { text, html };
  };

  const htmlToText = (html: string): string => {
    if (!html) return '';
    let s = html
      // remove style/script
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '');
    // preserve some structure
    s = s
      .replace(/<\/(p|div|li|h[1-6]|br|tr)>/gi, '\n')
      .replace(/<li>/gi, '- ');
    // strip tags
    s = s.replace(/<[^>]+>/g, ' ');
    // collapse whitespace
    s = s.replace(/\r?\n\s*\r?\n\s*/g, '\n\n');
    s = s.replace(/[ \t]+/g, ' ');
    return s.trim();
  };

  const stripQuoted = (s: string): string => {
    const markers = [
      /^On .* wrote:$/m,
      /^From: .*$/m,
      /^-----Original Message-----$/m,
      /^> ?On .* wrote:$/m,
    ];
    for (const re of markers) {
      const idx = s.search(re);
      if (idx !== -1) {
        return s.slice(0, idx).trim();
      }
    }
    return s.trim();
  };

  const stripFooters = (s: string): string => {
    const footerMarkers = [
      /This e-mail and any attachments are confidential/i,
      /This email and any attachments are confidential/i,
      /Please consider the environment before printing this email/i,
      /To unsubscribe/i,
      /Unsubscribe here/i,
    ];
    for (const re of footerMarkers) {
      const idx = s.search(re);
      if (idx !== -1) {
        return s.slice(0, idx).trim();
      }
    }
    return s;
  };

  const truncate = (s: string): string => {
    if (s.length <= MAX_CHARS) return s;
    return s.slice(0, MAX_CHARS) + '\n\n[truncated for model]';
  };
  // ---------- end helpers ----------

  // 1. extract text/html
  const { text, html } = extract(payload || {});

  // 2. prefer text, fallback to html→text
  let body = (text && text.trim()) || '';
  if (!body && html) {
    body = htmlToText(html);
  }

  // 3. clean up email-y stuff
  body = stripQuoted(body);
  body = stripFooters(body);

  // 4. final guard for LLM
  body = truncate(body);

  return body;
}
