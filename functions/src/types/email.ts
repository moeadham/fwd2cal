// Transformed email from Resend webhook
export interface TransformedEmail {
  subject: string;
  text: string;
  html: string;
  from: string;
  to: string[];
  headers: Record<string, string>;
  SPF: "pass" | "fail";
  dkim: string;
}

// Email headers
export interface EmailHeaders {
  date?: string;
  subject?: string;
  from?: string;
  "Message-ID"?: string;
  References?: string;
  [key: string]: string | undefined;
}

// ICS file attachment
export interface ICSFile {
  fieldname: string;
  file: Buffer;
  filename: { filename: string };
  encoding: string;
  mimetype: string;
}

// Attachment info from Resend
export interface AttachmentInfo {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  download_url: string;
}

// Processed attachments result
export interface ProcessedAttachments {
  icsFiles: ICSFile[];
  imageUrls: string[];
}

// Email response template
export interface EmailResponseTemplate {
  templateName: string;
  replace: Record<string, string>;
  subject?: boolean;
}

// Mail template
export interface MailTemplate {
  html: string;
  subject?: string;
}

// Mail templates collection
export interface MailTemplates {
  noUserFound: MailTemplate;
  unverifiedEmail: MailTemplate;
  oauthFailed: MailTemplate;
  unableToParse: MailTemplate;
  aiParseError: MailTemplate;
  eventAddedICS: MailTemplate;
  icsError: MailTemplate;
  eventAdded: MailTemplate;
  eventAddedAttendees: MailTemplate;
  addAdditionalEmailAddress: MailTemplate;
  additionalEmailInUse: MailTemplate;
  removalEmailInUse: MailTemplate;
  emailAddressRemoved: MailTemplate;
  userDeleted: MailTemplate;
}

// Handle email result
export interface HandleEmailResult {
  error?: string;
  result?: string;
  verificationCode?: string;
}

// Email thread headers for reply
export interface EmailThreadHeaders {
  "In-Reply-To"?: string;
  References?: string;
  [key: string]: string | undefined;
}
