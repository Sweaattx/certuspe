import nodemailer from "nodemailer";
import { Resend } from "resend";
import type { EmailReceipt } from "../shared/types";

export interface EmailDeliveryResult {
  status: EmailReceipt["status"];
  provider: EmailReceipt["provider"];
  sentAt: string | null;
  error: string | null;
}

type EmailTemplateConfig = NonNullable<EmailReceipt["template"]>;

function resendReady(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

function smtpReady(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function emailHtml(bodyText: string): string {
  const safeLines = bodyText
    .split("\n")
    .map((line) =>
      line
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
    )
    .map((line) => (line ? `<p>${line}</p>` : "<br />"))
    .join("");

  return `
    <div style="font-family: Arial, sans-serif; color: #171b29; line-height: 1.55; max-width: 560px;">
      <div style="border-bottom: 3px solid #1D3096; padding-bottom: 14px; margin-bottom: 18px;">
        <strong style="color: #1D3096; font-size: 18px;">CERTUSPE</strong>
        <div style="color: #5B6EA6; font-size: 12px;">Sistema de conteo preliminar</div>
      </div>
      ${safeLines}
    </div>
  `;
}

function resendTemplateId(kind: EmailTemplateConfig["kind"]): string | null {
  if (kind === "voter_otp") {
    return process.env.RESEND_OTP_TEMPLATE_ID ?? null;
  }
  if (kind === "vote_confirmation") {
    return process.env.RESEND_CONFIRMATION_TEMPLATE_ID ?? null;
  }
  return null;
}

export async function deliverEmailReceipt(email: EmailReceipt): Promise<Pick<EmailReceipt, "status" | "provider" | "sentAt" | "error">> {
  return deliverPlainEmail({
    to: email.to,
    subject: email.subject,
    bodyText: email.bodyText,
    template: email.template
  });
}

export async function deliverPlainEmail(input: {
  to: string;
  subject: string;
  bodyText: string;
  template?: EmailTemplateConfig;
}): Promise<EmailDeliveryResult> {
  if (resendReady()) {
    const resend = new Resend(process.env.RESEND_API_KEY);
    try {
      const from = process.env.RESEND_FROM ?? process.env.MAIL_FROM ?? "CERTUSPE <onboarding@resend.dev>";
      const templateId = input.template ? resendTemplateId(input.template.kind) : null;
      const payload = templateId
        ? {
            from,
            to: input.to,
            subject: input.subject,
            template: {
              id: templateId,
              variables: input.template?.variables
            }
          }
        : {
            from,
            to: input.to,
            subject: input.subject,
            text: input.bodyText,
            html: emailHtml(input.bodyText)
          };
      const { error } = await resend.emails.send(payload);

      if (error) {
        throw new Error(error.message);
      }

      return {
        status: "sent",
        provider: "resend",
        sentAt: new Date().toISOString(),
        error: null
      };
    } catch (err) {
      return {
        status: "failed",
        provider: "resend",
        sentAt: null,
        error: err instanceof Error ? err.message : "No se pudo enviar el correo con Resend."
      };
    }
  }

  if (!smtpReady()) {
    return {
      status: "queued",
      provider: "local_outbox",
      sentAt: null,
      error: null
    };
  }

  const port = Number(process.env.SMTP_PORT ?? 587);
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  try {
    await transporter.sendMail({
      from: process.env.MAIL_FROM ?? process.env.SMTP_USER,
      to: input.to,
      subject: input.subject,
      text: input.bodyText
    });

    return {
      status: "sent",
      provider: "smtp",
      sentAt: new Date().toISOString(),
      error: null
    };
  } catch (err) {
    return {
      status: "failed",
      provider: "smtp",
      sentAt: null,
      error: err instanceof Error ? err.message : "No se pudo enviar el correo."
    };
  }
}
