@extends('layouts.index')

@section('scripts')
    <script>
        const file = {!! json_encode($file) !!};
    </script>
@endsection

@section('content')
    <h1>{{$file->getNative()->getFilename()}}</h1>

    <div id="media_preview_dashboard">
        <div class="url" id="api_file_url">{{$file->url}}</div>
    </div>
    <br/>
    @if ($file->isImage())
        <img class="preview_content" src="{{url("/api")}}?path={{$file->getNative()->getRealPath()}}">
    @elseif ($file->isVideo())
        <video class="preview_content" preload="auto" src="{{url("/api")}}?path={{$file->getNative()->getRealPath()}}"
               controls>
        </video>
    @elseif($file->isPDF())
        <embed class="preview_content" src="{{url("/api")}}?path={{$file->getNative()->getRealPath()}}"
        />
    @endif
@endsection
