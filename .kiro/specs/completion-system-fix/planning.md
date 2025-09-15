# Requirements Document

## Introduction

This feature addresses critical issues in the completion system where file upload timing causes 404 errors and performance problems affect user experience. The system currently has misaligned request ordering where completion requests are sent before referenced files are uploaded, causing server-side failures. Additionally, excessive debouncing and context collection overhead significantly delays completion display.

## Problem Statement

The current implementation suffers from three primary defects:
1. **Race Condition**: Completion requests referencing files via paths are sent before those files are synchronized to the server, resulting in 404 errors
2. **Performance Degradation**: Excessive debouncing, overly broad context collection, and unnecessary debug overhead cause 200-500ms additional latency
3. **Reduced Trigger Frequency**: Over-aggressive gating logic prevents completions from triggering in valid scenarios where users expect them

## Terminology and Modes

### Core Concepts
- **Content Mode**: Completion requests that include file contents directly in the request body (self-contained)
- **File Reference Mode**: Completion requests that reference files by path, requiring prior file synchronization
- **additionalFiles**: Array of file references beyond the current file for multi-file context
- **FS Upload/Sync**: File system upload/synchronization operations that must complete before completion requests
- **Completion Stream**: Server-Sent Events (SSE) stream delivering completion suggestions

### Performance Metrics
- **TTFT (Time To First Token)**: Duration from trigger to first byte received from completion stream
- **TTFD (Time To First Display)**: Duration from trigger to visible completion in editor
- **MIN_REQUEST_INTERVAL**: Minimum 200ms interval between completion requests per editor instance

### System Components
- **streamCpp**: Completion streaming endpoint
- **FS Service**: File synchronization service handling uploads
- **pendingUploads**: Deduplication registry for in-flight file uploads
- **Completion Controller**: Orchestrator managing request lifecycle

## Non-Goals and Compatibility

### Explicit Non-Goals
- No protocol structure changes or new API endpoints
- No new business logic branches or feature additions
- No modifications to authentication mechanisms
- No changes to server-side processing logic
- No alterations to existing data models

### Compatibility Requirements
- Maintain full backward compatibility with existing clients
- Preserve all existing authentication mechanisms
- Support graceful degradation for network failures
- Ensure zero-downtime deployment capability

## System Behavior Specifications

### Cancellation and Preemption
- **Input Change Cancellation**: WHEN new input arrives or cursor jumps THEN the system SHALL immediately cancel in-flight FS and streamCpp operations via soft cancellation (close SSE connection, abort fetch)
- **Request Deduplication**: WHEN processing requests for same document and cursor position THEN the system SHALL NOT allow concurrent completion requests (deduplicate by docId+position hash)
- **Batch Cancellation**: WHEN cancelling FS batch THEN all uploads in that batch SHALL be cancelled atomically

### Error Handling Strategy
- **Fail-Fast Principle**: Errors SHALL be surfaced immediately without implicit retries that change mode
- **Error Propagation**: FS errors SHALL propagate to UI with diagnostic codes
- **No Silent Degradation**: System SHALL NOT automatically fall back from reference mode to content mode

## Observability and Rollback

### Telemetry Requirements
- **Mandatory Events**: fs_upload_started, fs_upload_finished, completion_triggered, completion_stream_started, completion_stream_ended, completion_cancelled
- **Required Fields**: fs_batch_id, fs_completed_count, fs_total_count, mode, ttft_ms, ttfd_ms, ctx_collect_ms, fs_wait_ms, dedup_hits, sse_start_ts, error_code
- **Correlation**: All events for single completion lifecycle SHALL share unique request_id

### Configuration and Feature Flags
```
completion.MAX_CTX_FILES=3              # Hot-reloadable, max additional files
completion.debugOutput=false            # Gradual rollout control
completion.enableSmartGating=false      # Read-only observation flag
completion.fsUploadTimeout=5000         # Per-file timeout in ms
completion.fsMaxRetries=2               # Maximum retry attempts
completion.fsMaxConcurrent=6            # Max concurrent uploads per batch
```

### Metrics and Logging Architecture
- **PII Minimization**: SHALL NOT log source code content, full file paths, or user identifiers
- **Log Sampling**: High-frequency events SHALL use sampling rate of 1:100 for production
- **Structured Logging**: All logs SHALL use structured format with consistent field names
- **Retention**: Performance metrics retained for 30 days, error logs for 90 days

## Requirements

### Requirement 1: File Upload Sequencing

**User Story:** As a developer using the completion system, I want file references to be properly uploaded before completion requests are sent, so that I don't encounter 404 errors when using multi-file completions.

#### Acceptance Criteria

**Mode Determination:**
1. WHEN additionalFiles.length > 0 THEN the system SHALL enter file reference mode
2. WHEN in file reference mode THEN contents field SHALL NOT appear in request body
3. WHEN in content mode (additionalFiles.length === 0) THEN the system SHALL include contents field and skip FS upload

**Upload Sequencing:**
4. WHEN additionalFiles exist THEN the system SHALL complete upload/sync for (currentFile ∪ additionalFiles) before proceeding
5. WHEN all FS operations return 2xx responses THEN the system SHALL send streamCpp request
6. WHEN sending streamCpp in reference mode THEN request body SHALL contain rely_on_filesync=true and additional_files array

**Timeout and Retry Logic:**
7. WHEN uploading single file THEN timeout threshold SHALL be 5 seconds
8. WHEN timeout occurs THEN the system SHALL retry with exponential backoff: [0.5s, 1.5s]
9. WHEN determining retry eligibility THEN:
   - 5xx errors: SHALL retry up to 2 times
   - Network timeouts: SHALL retry up to 2 times
   - 4xx errors: SHALL NOT retry
   - 3xx redirects: SHALL follow up to 3 redirects

**Failure Handling:**
10. WHEN FS upload fails after retries THEN the system SHALL:
    - Cancel entire completion request
    - Return diagnostic error code to UI
    - Log failure with fs_batch_id and error details
11. WHEN providing diagnostics THEN the system SHALL use codes:
    - FS_TIMEOUT: Upload exceeded timeout
    - FS_4XX: Client error from FS service
    - FS_5XX: Server error from FS service
    - FS_CANCELLED: User-initiated cancellation
    - FS_NETWORK: Network connectivity issue

**Concurrency Control:**
12. WHEN uploading files THEN concurrent FS uploads SHALL be limited to ≤6 per batch
13. WHEN deduplicating THEN the system SHALL:
    - Use key format: "workspaceId:relativePath:sha256"
    - Reuse in-flight requests for matching keys
    - Maintain upload registry with TTL of 30 seconds

### Requirement 2: Performance Optimization

**User Story:** As a developer, I want completion suggestions to appear quickly after typing, so that my coding flow is not interrupted by long delays.

#### Acceptance Criteria

**Latency Reduction:**
1. WHEN a completion is triggered THEN the system SHALL:
   - Remove adaptive debouncing delays
   - Use fixed MIN_REQUEST_INTERVAL of 200ms
   - Skip smart gating evaluation

**Context Optimization:**
2. WHEN collecting context THEN the system SHALL:
   - Limit multi-file context to maximum 3 files
   - Prioritize files by: current imports > recent edits > same directory
   - Cap total context size at 50KB

**Overhead Elimination:**
3. WHEN making completion requests THEN the system SHALL:
   - Disable debug output in production
   - Remove unnecessary serialization steps
   - Use streaming JSON parsing

**Performance Budget:**
4. WHEN measuring Time To First Token (TTFT) THEN:
   - p50 SHALL be ≤ 100ms
   - p95 SHALL be ≤ 150ms
   - p99 SHALL be ≤ 300ms

5. WHEN measuring Time To First Display (TTFD) THEN:
   - p50 SHALL be ≤ 150ms
   - p95 SHALL be ≤ 250ms
   - p99 SHALL be ≤ 500ms

6. WHEN comparing before/after in A/B testing THEN:
   - TTFD p95 SHALL decrease by ≥ 20%
   - TTFT p95 SHALL decrease by ≥ 15%

### Requirement 3: Trigger Frequency Enhancement

**User Story:** As a developer, I want the completion system to trigger as frequently as Cursor Tab, so that I have consistent completion availability across different scenarios.

#### Acceptance Criteria

**Trigger Logic:**
1. WHEN typing in the editor THEN the system SHALL:
   - Use only shouldTriggerCompletionBasic checks
   - Skip smart edit gating logic
   - Maintain position-based triggers

**Trigger Conditions:**
2. WHEN evaluating triggers THEN the system SHALL preserve:
   - Minimum 2-character threshold after whitespace
   - Line-end boundary detection
   - Post-operator triggers (., ->, ::)

3. WHEN comparing to baseline THEN:
   - Trigger frequency SHALL be ≥ 0.9× Cursor Tab rate
   - False positive rate SHALL remain < 5%

### Requirement 4: Protocol and Security Compliance

**User Story:** As a developer, I want the system to maintain proper authentication and protocol compliance, so that security and compatibility are preserved during the fixes.

#### Acceptance Criteria

**Authentication:**
1. WHEN uploading files THEN the system SHALL:
   - Include x-fs-client-key header
   - Maintain FilesyncCookie in requests
   - Preserve workspace isolation

**Protocol Compliance:**
2. WHEN making requests THEN the system SHALL:
   - Not modify existing protocol structures
   - Maintain backward compatibility
   - Support protocol version negotiation

**Security:**
3. WHEN handling sensitive data THEN the system SHALL:
   - Not log file contents
   - Sanitize paths in logs
   - Maintain encryption in transit

### Requirement 5: Verification and Testing

**User Story:** As a developer, I want to verify that the fixes work correctly, so that I can confirm the issues are resolved.

#### Acceptance Criteria

**Functional Verification:**
1. WHEN using multi-file references THEN:
   - 404 error rate SHALL equal 0% (n≥200, 95% CI upper bound < 1.5%)
   - All files SHALL be synchronized before completion request

**Performance Verification:**
2. WHEN measuring performance THEN:
   - TTFD reduction SHALL be ≥ 20% (p95)
   - Trigger rate SHALL be ≥ 0.9× baseline

**Regression Testing:**
3. WHEN running test suites THEN:
   - Content mode tests SHALL pass 100%
   - Reference mode tests SHALL pass 100%
   - Error handling tests SHALL pass 100%
   - Edge case tests SHALL pass 100%

**Monitoring:**
4. WHEN deployed to production THEN:
   - Error rate dashboards SHALL show improvements
   - Performance metrics SHALL meet SLOs
   - No increase in server-side errors

## Implementation Phases

### Phase 1: File Upload Sequencing (Week 1-2)
- Implement FS-before-completion logic
- Add retry and timeout handling
- Deploy with feature flag at 5% traffic

### Phase 2: Performance Optimization (Week 2-3)
- Remove debouncing delays
- Optimize context collection
- Gradual rollout to 25% traffic

### Phase 3: Trigger Enhancement (Week 3-4)
- Simplify trigger logic
- A/B test against baseline
- Full rollout if metrics positive

## Success Metrics

### Primary Metrics
- 404 error rate: 0% for multi-file completions
- TTFD p95: ≤ 250ms (20% improvement)
- Trigger frequency: ≥ 0.9× Cursor Tab baseline

### Secondary Metrics
- User satisfaction score improvement
- Completion acceptance rate increase
- Reduced support tickets for completion issues

## Risk Mitigation

### Identified Risks
1. **Increased Server Load**: Mitigated by rate limiting and gradual rollout
2. **Regression in Edge Cases**: Mitigated by comprehensive test coverage
3. **Network Latency Impact**: Mitigated by timeout and retry logic

### Rollback Plan
- Feature flags enable instant rollback
- Canary deployment limits blast radius
- Automated rollback on error rate spike > 2%