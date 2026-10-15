import { expectAssignable, expectNotAssignable } from 'tsd'
import Interceptors from '../../types/interceptors'

expectAssignable<Interceptors.ResponseErrorInterceptorOpts>({})
expectAssignable<Interceptors.ResponseErrorInterceptorOpts>({ mimeTypes: { 'text/xml': 'text', 'application/problem+json': 'json' } })
expectNotAssignable<Interceptors.ResponseErrorInterceptorOpts>({ mimeTypes: ['text/xml'] })
expectNotAssignable<Interceptors.ResponseErrorInterceptorOpts>({ mimeTypes: { 'text/xml': 'xml' } })
