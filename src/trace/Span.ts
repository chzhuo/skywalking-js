/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as api from '@opentelemetry/api';
import {
  isAttributeValue,
  hrTime,
  hrTimeDuration,
  InstrumentationLibrary,
  isTimeInput,
  timeInputToHrTime,
} from '@opentelemetry/core';
import { SemanticAttributes } from '@opentelemetry/semantic-conventions';
import { TimedEvent } from './TimedEvent';
import Tracer from './Tracer';
import { SpanLimits } from './types';
import { SpanAttributeValue } from '@opentelemetry/api';
import { ExceptionEventName } from './enums';
import Segment from './context/Segment';
import SegmentRef from '../trace/context/SegmentRef';
import { traceIdFakedButValid, SpanIdFakedButValid, attribeValueToString } from './utility';
import { createLogger } from '../logging';

const logger = createLogger(__filename);

export default class Span implements api.Span, api.SpanContext {
  // inhrerited from SpanContext
  traceId: string = traceIdFakedButValid; // limit by regex /^([0-9a-f]{32})$/i;
  spanId: string = SpanIdFakedButValid; // limit by regex /^[0-9a-f]{16}$/i;
  isRemote?: boolean | undefined = false; // always false

  // Below properties are included to implement ReadableSpan for export
  // purposes but are not intended to be written-to directly.
  readonly attributes: api.SpanAttributes = {};
  readonly events: TimedEvent[] = [];
  readonly instrumentationLibrary: InstrumentationLibrary;
  status: api.SpanStatus = {
    code: api.SpanStatusCode.UNSET,
  };
  endTime: api.HrTime = [0, 0];
  private _ended = false;
  private _duration: api.HrTime = [-1, -1];
  private readonly _spanLimits: SpanLimits;
  private readonly _attributeValueLengthLimit: number;
  readonly segmentSpanId: number;
  refs: SegmentRef[] = [];

  /** Constructs a new Span instance. */
  constructor(
    parentTracer: Tracer,
    public name: string,
    readonly kind: api.SpanKind,
    readonly segment: Segment,
    readonly segmentParentSpanId: number,
    public startTime: api.HrTime = hrTime(),
    public segmentRef: SegmentRef | undefined,
    public traceFlags: number = 0,
    public traceState?: api.TraceState | undefined,
  ) {
    this.segmentSpanId = segment.startSpan(this);
    if (segmentRef) {
      this.refs.push(segmentRef);
    }
    this.instrumentationLibrary = parentTracer.instrumentationLibrary;
    this._spanLimits = parentTracer.getSpanLimits();
    this._attributeValueLengthLimit = this._spanLimits.attributeValueLengthLimit || 0;
    if (logger.isDebugEnabled()) {
      logger.debug(`Span created: ${this.segment.traceId}/${this.segment.segmentId}/${this.segmentSpanId}`);
    }
  }

  spanContext(): api.SpanContext {
    return this;
  }

  setAttribute(key: string, value?: SpanAttributeValue): this;
  setAttribute(key: string, value: unknown): this {
    if (value == null || this._isSpanEnded()) return this;
    if (key.length === 0) {
      api.diag.warn(`Invalid attribute key: ${key}`);
      return this;
    }
    if (!isAttributeValue(value)) {
      api.diag.warn(`Invalid attribute value set for key: ${key}`);
      return this;
    }

    if (
      Object.keys(this.attributes).length >= this._spanLimits.attributeCountLimit! &&
      !Object.prototype.hasOwnProperty.call(this.attributes, key)
    ) {
      return this;
    }
    this.attributes[key] = this._truncateToSize(value);
    return this;
  }

  setAttributes(attributes: api.SpanAttributes): this {
    for (const [k, v] of Object.entries(attributes)) {
      this.setAttribute(k, v);
    }
    return this;
  }

  /**
   *
   * @param name Span Name
   * @param [attributesOrStartTime] Span attributes or start time
   *     if type is {@type TimeInput} and 3rd param is undefined
   * @param [startTime] Specified start time for the event
   */
  addEvent(name: string, attributesOrStartTime?: api.SpanAttributes | api.TimeInput, startTime?: api.TimeInput): this {
    if (this._isSpanEnded()) return this;
    if (this.events.length >= this._spanLimits.eventCountLimit!) {
      api.diag.warn('Dropping extra events.');
      this.events.shift();
    }
    if (isTimeInput(attributesOrStartTime)) {
      if (typeof startTime === 'undefined') {
        startTime = attributesOrStartTime as api.TimeInput;
      }
      attributesOrStartTime = undefined;
    }
    if (typeof startTime === 'undefined') {
      startTime = hrTime();
    }
    this.events.push({
      name,
      attributes: attributesOrStartTime as api.SpanAttributes,
      time: timeInputToHrTime(startTime),
    });
    return this;
  }

  setStatus(status: api.SpanStatus): this {
    if (this._isSpanEnded()) return this;
    this.status = status;
    if (status.message) {
      this.attributes['error.message'] = status.message;
    }
    return this;
  }

  updateName(name: string): this {
    if (this._isSpanEnded()) return this;
    this.name = name;
    return this;
  }

  end(endTime: api.TimeInput = hrTime()): void {
    if (this._isSpanEnded()) {
      api.diag.error('You can only call end() on a span once.');
      return;
    }
    this._ended = true;
    this.endTime = timeInputToHrTime(endTime);

    this._duration = hrTimeDuration(this.startTime, this.endTime);
    if (this._duration[0] < 0) {
      api.diag.warn('Inconsistent start and end time, startTime > endTime', this.startTime, this.endTime);
    }
    this.segment.endSpan(this);
    if (logger.isDebugEnabled()) {
      logger.debug(`Span Ended: ${this.segment.traceId}/${this.segment.segmentId}/${this.segmentSpanId}`);
    }
  }

  isRecording(): boolean {
    return this._ended === false;
  }

  recordException(exception: api.Exception, time: api.TimeInput = hrTime()): void {
    const attributes: api.SpanAttributes = {};
    if (typeof exception === 'string') {
      attributes[SemanticAttributes.EXCEPTION_MESSAGE] = exception;
    } else if (exception) {
      if (exception.code) {
        attributes[SemanticAttributes.EXCEPTION_TYPE] = exception.code.toString();
      } else if (exception.name) {
        attributes[SemanticAttributes.EXCEPTION_TYPE] = exception.name;
      }
      if (exception.message) {
        attributes[SemanticAttributes.EXCEPTION_MESSAGE] = exception.message;
      }
      if (exception.stack) {
        attributes[SemanticAttributes.EXCEPTION_STACKTRACE] = exception.stack;
      }
    }

    // these are minimum requirements from spec
    if (attributes[SemanticAttributes.EXCEPTION_TYPE] || attributes[SemanticAttributes.EXCEPTION_MESSAGE]) {
      this.addEvent(ExceptionEventName, attributes as api.SpanAttributes, time);
    } else {
      api.diag.warn(`Failed to record an exception ${exception}`);
    }
  }

  get duration(): api.HrTime {
    return this._duration;
  }

  get ended(): boolean {
    return this._ended;
  }

  private _isSpanEnded(): boolean {
    if (this._ended) {
      api.diag.warn(
        `Can not execute the operation on ended Span {traceId: ${this.segment.traceId}, spanId: ${this.segment.segmentId}}`,
      );
    }
    return this._ended;
  }

  // Utility function to truncate given value within size
  // for value type of string, will truncate to given limit
  // for type of non-string, will return same value
  private _truncateToLimitUtil(value: string, limit: number): string {
    if (value.length <= limit) {
      return value;
    }
    return value.substr(0, limit);
  }

  /**
   * If the given attribute value is of type string and has more characters than given {@code attributeValueLengthLimit} then
   * return string with trucated to {@code attributeValueLengthLimit} characters
   *
   * If the given attribute value is array of strings then
   * return new array of strings with each element truncated to {@code attributeValueLengthLimit} characters
   *
   * Otherwise return same Attribute {@code value}
   *
   * @param value Attribute value
   * @returns truncated attribute value if required, otherwise same value
   */
  private _truncateToSize(value: SpanAttributeValue): SpanAttributeValue {
    const limit = this._attributeValueLengthLimit;
    // Check limit
    if (limit <= 0) {
      // Negative values are invalid, so do not truncate
      api.diag.warn(`Attribute value limit must be positive, got ${limit}`);
      return value;
    }

    // String
    if (typeof value === 'string') {
      return this._truncateToLimitUtil(value, limit);
    }

    // Array of strings
    if (Array.isArray(value)) {
      return (value as []).map((val) => (typeof val === 'string' ? this._truncateToLimitUtil(val, limit) : val));
    }

    // Other types, no need to apply value length limit
    return value;
  }

  public getEndpoint(): string {
    const endpoint =
      this.attributes[SemanticAttributes.HTTP_TARGET] ||
      this.attributes[SemanticAttributes.HTTP_ROUTE] ||
      this.attributes[SemanticAttributes.PEER_SERVICE];
    return attribeValueToString(endpoint) || '/';
  }
}