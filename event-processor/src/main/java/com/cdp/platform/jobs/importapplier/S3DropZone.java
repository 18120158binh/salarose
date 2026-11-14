package com.cdp.platform.jobs.importapplier;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Path;
import java.util.Optional;

import software.amazon.awssdk.core.exception.SdkException;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.http.urlconnection.UrlConnectionHttpClient;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.NoSuchKeyException;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;

/**
 * The drop zone on S3, with the credentials of the pod's runtime from the
 * SDK's default chain and the region from {@code AWS_REGION}, as studio's.
 */
final class S3DropZone implements DropZone {

    private final S3Client client;
    private final String bucket;

    S3DropZone(String bucket) {
        this.client = S3Client.builder().httpClientBuilder(UrlConnectionHttpClient.builder()).build();
        this.bucket = bucket;
    }

    @Override
    public Optional<InputStream> open(String key) throws IOException {
        try {
            return Optional.of(client.getObject(GetObjectRequest.builder().bucket(bucket).key(key).build()));
        } catch (NoSuchKeyException e) {
            return Optional.empty();
        } catch (SdkException e) {
            throw new IOException("reading the drop zone failed", e);
        }
    }

    @Override
    public void put(String key, byte[] body, String contentType) throws IOException {
        try {
            client.putObject(request(key, contentType), RequestBody.fromBytes(body));
        } catch (SdkException e) {
            throw new IOException("writing the drop zone failed", e);
        }
    }

    @Override
    public void put(String key, Path file, String contentType) throws IOException {
        try {
            client.putObject(request(key, contentType), RequestBody.fromFile(file));
        } catch (SdkException e) {
            throw new IOException("writing the drop zone failed", e);
        }
    }

    private PutObjectRequest request(String key, String contentType) {
        return PutObjectRequest.builder().bucket(bucket).key(key).contentType(contentType).build();
    }
}
