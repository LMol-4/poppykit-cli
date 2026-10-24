#import <Foundation/Foundation.h>
#import <Security/Security.h>
#include <stdio.h>

static NSDictionary *failure(NSString *phase, OSStatus status) {
  BOOL locked = status == errSecInteractionNotAllowed || status == errSecAuthFailed || status == errSecUserCanceled;
  return @{ @"ok": @NO, @"code": locked ? @"secure_store_locked" : @"secure_store_unavailable", @"phase": phase, @"status": @(status) };
}

static NSDictionary *handle(NSDictionary *input) {
  NSSet *allowed = [NSSet setWithArray:@[@"action", @"service", @"value", @"interactive"]];
  if (![input isKindOfClass:NSDictionary.class] || ![[NSSet setWithArray:input.allKeys] isSubsetOfSet:allowed]) return failure(@"input", errSecParam);
  NSString *action = input[@"action"], *service = input[@"service"], *value = input[@"value"];
  if (![action isKindOfClass:NSString.class] || ![@[@"load", @"adopt"] containsObject:action] || ![service isKindOfClass:NSString.class]
      || [service rangeOfString:@"^org\\.poppykit\\.cli\\.vault\\.[a-f0-9]{64}$" options:NSRegularExpressionSearch].location == NSNotFound
      || (input[@"interactive"] && CFGetTypeID((__bridge CFTypeRef)input[@"interactive"]) != CFBooleanGetTypeID())) return failure(@"input", errSecParam);
  NSData *secret = [value isKindOfClass:NSString.class] ? [value dataUsingEncoding:NSUTF8StringEncoding] : nil;
  if ([action isEqual:@"adopt"] && (!secret || value.length < 12 || value.length > 4096 || secret.length > 16384)) return failure(@"input", errSecParam);
  SecKeychainSetUserInteractionAllowed([input[@"interactive"] boolValue]);
  SecKeychainRef keychain = NULL;
  OSStatus status = SecKeychainCopyDefault(&keychain);
  if (status != errSecSuccess) return failure(@"keychain", status);
  @try {
    NSDictionary *identity = @{ (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
      (__bridge id)kSecAttrService: service, (__bridge id)kSecAttrAccount: @"vault-key-v1" };
    if ([action isEqual:@"adopt"]) {
      NSMutableDictionary *add = [identity mutableCopy];
      add[(__bridge id)kSecUseKeychain] = (__bridge id)keychain;
      add[(__bridge id)kSecAttrLabel] = @"PoppyKit CLI local vault";
      add[(__bridge id)kSecValueData] = secret;
      status = SecItemAdd((__bridge CFDictionaryRef)add, NULL);
      if (status != errSecSuccess && status != errSecDuplicateItem) return failure(@"add", status);
    }
    NSMutableDictionary *query = [identity mutableCopy];
    query[(__bridge id)kSecMatchSearchList] = @[(__bridge id)keychain];
    query[(__bridge id)kSecReturnData] = @YES;
    query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
    CFTypeRef result = NULL;
    status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
    if (status == errSecItemNotFound) return @{ @"ok": @YES, @"value": NSNull.null };
    if (status != errSecSuccess) return failure(@"read", status);
    NSData *data = CFBridgingRelease(result);
    if (![data isKindOfClass:NSData.class] || data.length > 16384) return failure(@"decode", errSecParam);
    NSString *decoded = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (!decoded || decoded.length < 12 || decoded.length > 4096) return failure(@"decode", errSecParam);
    return @{ @"ok": @YES, @"value": decoded };
  } @finally { CFRelease(keychain); }
}

int main(void) {
  @autoreleasepool {
    NSDictionary *response = nil;
    @try {
      NSMutableData *input = [NSMutableData data];
      unsigned char buffer[4096]; size_t length;
      while ((length = fread(buffer, 1, sizeof(buffer), stdin)) > 0) {
        if (input.length + length > 32768) { response = failure(@"input", errSecParam); break; }
        [input appendBytes:buffer length:length];
      }
      if (!response) response = ferror(stdin) ? failure(@"input", errSecParam) : handle([NSJSONSerialization JSONObjectWithData:input options:0 error:NULL]);
    } @catch (__unused NSException *exception) { response = failure(@"input", errSecParam); }
    NSData *output = [NSJSONSerialization dataWithJSONObject:response options:0 error:NULL];
    return output && fwrite(output.bytes, 1, output.length, stdout) == output.length ? 0 : 1;
  }
}
