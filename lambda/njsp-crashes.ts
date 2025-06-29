import { decode } from "@rdub/next-params/query"
import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from "aws-lambda"
import { getCrashPage } from "./server/crash-page"
import { spDdb } from "./server/njsp/ddb"
import {Crash, CrashPage} from "./src/njsp/crash"
import * as q from "./src/query"

export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context
): Promise<APIGatewayProxyResult> => {
  console.log("Lambda event:", JSON.stringify(event, null, 2))
  
  try {
    // Extract query parameters from Lambda event
    const queryStringParameters = event.queryStringParameters || {}
    
    // Create a mock request object for the decode function
    const mockReq = {
      query: queryStringParameters
    }
    
    const { p: page, pp: perPage, cc, mc } = decode(mockReq as any, q.CrashPage)
    
    const crashPage: CrashPage = await getCrashPage(spDdb, { cc, mc, page, perPage, })
    
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: JSON.stringify(crashPage)
    }
  } catch (error) {
    console.error("Lambda error:", error)
    
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : 'Unknown error'
      })
    }
  }
}
