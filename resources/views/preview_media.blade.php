@extends('layouts.index')

@section('scripts')
    <script>
        const file = {!! json_encode($file) !!};
    </script>
@endsection

@section('content')
    <h1>{{$file->getNative()->getFilename()}}</h1>

    @if ($file->isImage())
        <img src="{{url("/api")}}?path={{$file->getNative()->getRealPath()}}"
             style="width: 70%; margin: auto; text-align: center;">
    @elseif ($file->isVideo())
        <video controls>
            <source src="{{url("/api")}}?path={{$file->getNative()->getRealPath()}}" type="{{$file->getMimeType()}}">
        </video>
    @endif

    <br/>
@endsection
