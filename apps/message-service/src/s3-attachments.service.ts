import { Injectable } from '@nestjs/common';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

@Injectable()
export class S3AttachmentsService {
  private readonly bucket = (process.env.S3_BUCKET || '').trim();
  private readonly uploadUrlExpiresIn = Number(process.env.S3_UPLOAD_URL_EXPIRES_SECONDS || '900');
  private readonly downloadUrlExpiresIn = Number(process.env.S3_DOWNLOAD_URL_EXPIRES_SECONDS || '900');

  private readonly client = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE || 'false').toLowerCase() === 'true',
    credentials:
      process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            sessionToken: process.env.AWS_SESSION_TOKEN || undefined
          }
        : undefined
  });

  getUploadUrlExpiresIn() {
    return this.uploadUrlExpiresIn;
  }

  buildObjectKey(ownerUserId: string, attachmentId: string, fileName: string) {
    const normalizedFileName = this.normalizeFileName(fileName);
    return `${ownerUserId}/${attachmentId}/${normalizedFileName}`;
  }

  async createUploadUrl(objectKey: string, contentType: string) {
    this.ensureConfigured();
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
      ContentType: contentType
    });

    return getSignedUrl(this.client, command, { expiresIn: this.uploadUrlExpiresIn });
  }

  async createDownloadUrl(objectKey: string) {
    this.ensureConfigured();
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: objectKey
    });

    return getSignedUrl(this.client, command, { expiresIn: this.downloadUrlExpiresIn });
  }

  async objectExists(objectKey: string) {
    this.ensureConfigured();
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: objectKey
        })
      );
      return true;
    } catch {
      return false;
    }
  }

  private ensureConfigured() {
    if (!this.bucket) {
      throw new Error('S3_BUCKET_NOT_CONFIGURED');
    }
  }

  private normalizeFileName(fileName: string) {
    const base = (fileName || 'file').split('/').pop()?.split('\\').pop() || 'file';
    return base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180) || 'file';
  }
}
