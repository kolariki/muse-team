import { Composition } from 'remotion'
import { Ad, adMetadata, SAMPLE, type AdProps } from './Ad'

export const Root = () => (
  <Composition id="Ad" component={Ad} defaultProps={SAMPLE as AdProps} calculateMetadata={adMetadata} fps={30} width={1080} height={1920} durationInFrames={450} />
)
